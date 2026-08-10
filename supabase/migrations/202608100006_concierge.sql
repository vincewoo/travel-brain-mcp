-- Step 4 concierge read support and atomic itinerary-change proposals.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'itinerary_change_proposal_status'
  ) then
    create type public.itinerary_change_proposal_status
      as enum ('pending', 'committed', 'rejected', 'expired');
  end if;
end $$;

create table public.itinerary_change_proposals (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  status public.itinerary_change_proposal_status not null default 'pending',
  summary text not null check (length(btrim(summary)) > 0),
  rationale text,
  operations jsonb not null default '[]'::jsonb,
  validation jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itinerary_change_operations_array check (
    jsonb_typeof(operations) = 'array' and jsonb_array_length(operations) between 1 and 50
  ),
  constraint itinerary_change_validation_object check (jsonb_typeof(validation) = 'object')
);

create index itinerary_change_proposals_trip_status_idx
  on public.itinerary_change_proposals(trip_id, status, created_at desc);

create trigger itinerary_change_proposals_set_updated_at
before update on public.itinerary_change_proposals
for each row execute function public.set_updated_at();

alter table public.itinerary_change_proposals enable row level security;

create policy itinerary_change_member_select
  on public.itinerary_change_proposals
  for select
  using (public.is_trip_member(trip_id));

create policy itinerary_change_editor_insert
  on public.itinerary_change_proposals
  for insert
  with check (
    created_by = auth.uid()
    and status = 'pending'
    and committed_at is null
    and public.can_edit_trip(trip_id)
  );

-- There is deliberately no direct update/delete policy. Status changes and
-- itinerary mutations pass through the checked transaction below.

create or replace function public.nearby_trip_places(
  p_trip_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision default 1500,
  p_category text default null,
  p_statuses public.trip_place_status[] default null,
  p_limit integer default 25
)
returns table (
  place_id uuid,
  name text,
  category text,
  address text,
  locality text,
  region text,
  country_code text,
  trip_status public.trip_place_status,
  priority smallint,
  distance_meters double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    p.id,
    p.name,
    p.category,
    p.address,
    p.locality,
    p.region,
    p.country_code,
    tp.status,
    tp.priority,
    extensions.st_distance(
      p.location,
      extensions.st_setsrid(
        extensions.st_makepoint(p_longitude, p_latitude),
        4326
      )::extensions.geography
    ) as distance_meters
  from public.trip_places tp
  join public.places p on p.id = tp.place_id
  where tp.trip_id = p_trip_id
    and p.location is not null
    and (p_category is null or p.category = p_category)
    and (p_statuses is null or tp.status = any(p_statuses))
    and extensions.st_dwithin(
      p.location,
      extensions.st_setsrid(
        extensions.st_makepoint(p_longitude, p_latitude),
        4326
      )::extensions.geography,
      p_radius_meters
    )
  order by distance_meters asc
  limit greatest(1, least(p_limit, 25));
$$;

revoke all on function public.nearby_trip_places(
  uuid, double precision, double precision, double precision, text,
  public.trip_place_status[], integer
) from public;
grant execute on function public.nearby_trip_places(
  uuid, double precision, double precision, double precision, text,
  public.trip_place_status[], integer
) to authenticated, service_role;

create or replace function public.commit_itinerary_change_proposal(
  p_proposal_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_proposal public.itinerary_change_proposals%rowtype;
  v_operation jsonb;
  v_patch jsonb;
  v_item public.itinerary_items%rowtype;
  v_item_id uuid;
  v_place_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_changed_ids uuid[] := '{}'::uuid[];
  v_added_ids uuid[] := '{}'::uuid[];
  v_seen_ids uuid[] := '{}'::uuid[];
  v_stale_ids uuid[] := '{}'::uuid[];
  v_changed_items jsonb := '[]'::jsonb;
  v_added_items jsonb := '[]'::jsonb;
  v_committed_at timestamptz;
begin
  if p_actor_id is null then
    raise exception using errcode = '42501', message = 'Actor identity is required.';
  end if;

  v_actor_id := coalesce(auth.uid(), p_actor_id);
  if auth.uid() is not null and auth.uid() <> p_actor_id then
    raise exception using errcode = '42501', message = 'Actor identity does not match the authenticated user.';
  end if;

  select * into v_proposal
  from public.itinerary_change_proposals
  where id = p_proposal_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Itinerary change proposal not found.';
  end if;

  if not (
    exists (select 1 from public.trips t where t.id = v_proposal.trip_id and t.owner_id = v_actor_id)
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = v_proposal.trip_id
        and tm.user_id = v_actor_id
        and tm.role in ('owner', 'editor')
    )
  ) then
    raise exception using errcode = '42501', message = 'Trip access is read-only.';
  end if;

  -- IDs for add operations are assigned when proposed, so repeated commits
  -- can return the same rows without inserting duplicates.
  select coalesce(array_agg((operation->'item'->>'id')::uuid), '{}'::uuid[])
    into v_added_ids
  from jsonb_array_elements(v_proposal.operations) operation
  where operation->>'op' = 'add'
    and operation->'item'->>'id' is not null
    and operation->'item'->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  select coalesce(array_agg((operation->>'itinerary_item_id')::uuid), '{}'::uuid[])
    into v_changed_ids
  from jsonb_array_elements(v_proposal.operations) operation
  where operation->>'op' = 'update'
    and operation->>'itinerary_item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  if v_proposal.status = 'committed' then
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
      into v_changed_items from public.itinerary_items i where i.id = any(v_changed_ids);
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
      into v_added_items from public.itinerary_items i where i.id = any(v_added_ids);
    return jsonb_build_object(
      'proposal_id', v_proposal.id,
      'status', 'committed',
      'committed_at', v_proposal.committed_at,
      'changed_items', v_changed_items,
      'added_items', v_added_items,
      'idempotent_replay', true
    );
  end if;

  if v_proposal.status <> 'pending' then
    return jsonb_build_object(
      'error_code', 'PROPOSAL_NOT_PENDING',
      'message', format('Proposal status is %s.', v_proposal.status)
    );
  end if;

  if v_proposal.expires_at is not null and v_proposal.expires_at <= now() then
    update public.itinerary_change_proposals set status = 'expired' where id = v_proposal.id;
    return jsonb_build_object(
      'error_code', 'EXPIRED_PROPOSAL',
      'message', 'The itinerary change proposal has expired.'
    );
  end if;

  -- Lock every existing item in stable order before validating any operation.
  perform 1
  from public.itinerary_items i
  where i.id = any(v_changed_ids)
  order by i.id
  for update;

  for v_operation in select value from jsonb_array_elements(v_proposal.operations)
  loop
    if jsonb_typeof(v_operation) <> 'object' then
      raise exception 'Each proposal operation must be an object.';
    end if;

    if v_operation->>'op' = 'update' then
      if not (v_operation->>'itinerary_item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
        raise exception 'Update operation has an invalid itinerary_item_id.';
      end if;
      v_item_id := (v_operation->>'itinerary_item_id')::uuid;
      if v_item_id = any(v_seen_ids) then
        raise exception 'A proposal may touch each itinerary item only once.';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_item_id);
      v_patch := v_operation->'patch';
      if jsonb_typeof(v_patch) <> 'object' or v_patch = '{}'::jsonb then
        raise exception 'Update patch must be a non-empty object.';
      end if;
      if (v_patch - array['planned_start', 'planned_end', 'status', 'flexibility', 'priority', 'notes']) <> '{}'::jsonb then
        raise exception 'Update patch contains a field that is not allowed.';
      end if;

      select * into v_item from public.itinerary_items
      where id = v_item_id and trip_id = v_proposal.trip_id;
      if not found then
        v_stale_ids := array_append(v_stale_ids, v_item_id);
        continue;
      end if;
      if v_operation->>'expected_updated_at' is null
        or v_item.updated_at is distinct from (v_operation->>'expected_updated_at')::timestamptz then
        v_stale_ids := array_append(v_stale_ids, v_item_id);
      end if;

      v_start := case when v_patch ? 'planned_start' then (v_patch->>'planned_start')::timestamptz else v_item.planned_start end;
      v_end := case when v_patch ? 'planned_end' then (v_patch->>'planned_end')::timestamptz else v_item.planned_end end;
      if v_start is not null and v_end is not null and v_end < v_start then
        raise exception 'Update operation has planned_end before planned_start.';
      end if;
      if v_patch ? 'priority' and ((v_patch->>'priority')::integer not between 1 and 5) then
        raise exception 'Update operation priority must be between 1 and 5.';
      end if;
      if v_patch ? 'status' then
        if (v_patch->>'status') not in ('planned', 'confirmed', 'skipped', 'cancelled') then
          raise exception 'Proposal update status is not allowed.';
        end if;
        perform (v_patch->>'status')::public.itinerary_status;
      end if;
      if v_patch ? 'flexibility' then perform (v_patch->>'flexibility')::public.flexibility_level; end if;

    elsif v_operation->>'op' = 'add' then
      if jsonb_typeof(v_operation->'item') <> 'object' then
        raise exception 'Add operation item must be an object.';
      end if;
      if ((v_operation->'item') - array[
        'id', 'title', 'place_id', 'item_type', 'planned_start', 'planned_end',
        'timezone', 'flexibility', 'priority', 'status', 'notes', 'metadata'
      ]) <> '{}'::jsonb then
        raise exception 'Add operation contains a field that is not allowed.';
      end if;
      if not (v_operation->'item'->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
        raise exception 'Add operation has an invalid id.';
      end if;
      v_item_id := (v_operation->'item'->>'id')::uuid;
      if v_item_id = any(v_seen_ids) or exists (select 1 from public.itinerary_items where id = v_item_id) then
        raise exception 'Add operation id is duplicate or already exists.';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_item_id);
      if nullif(btrim(v_operation->'item'->>'title'), '') is null then
        raise exception 'Add operation title is required.';
      end if;
      v_start := (v_operation->'item'->>'planned_start')::timestamptz;
      v_end := (v_operation->'item'->>'planned_end')::timestamptz;
      if v_start is not null and v_end is not null and v_end < v_start then
        raise exception 'Add operation has planned_end before planned_start.';
      end if;
      if v_operation->'item' ? 'priority'
        and ((v_operation->'item'->>'priority')::integer not between 1 and 5) then
        raise exception 'Add operation priority must be between 1 and 5.';
      end if;
      if v_operation->'item' ? 'status' then
        if (v_operation->'item'->>'status') not in ('planned', 'confirmed') then
          raise exception 'Proposal add status is not allowed.';
        end if;
        perform (v_operation->'item'->>'status')::public.itinerary_status;
      end if;
      if v_operation->'item' ? 'flexibility' then perform (v_operation->'item'->>'flexibility')::public.flexibility_level; end if;
      if v_operation->'item'->>'place_id' is not null then
        v_place_id := (v_operation->'item'->>'place_id')::uuid;
        if not exists (
          select 1 from public.trip_places tp
          where tp.trip_id = v_proposal.trip_id and tp.place_id = v_place_id
        ) then
          raise exception 'Add operation place is not saved to this trip.';
        end if;
      end if;
    else
      raise exception 'Unsupported proposal operation.';
    end if;
  end loop;

  if cardinality(v_stale_ids) > 0 then
    return jsonb_build_object(
      'error_code', 'STALE_PROPOSAL',
      'message', 'One or more itinerary items changed after this proposal was created.',
      'changed_item_ids', to_jsonb(v_stale_ids)
    );
  end if;

  for v_operation in select value from jsonb_array_elements(v_proposal.operations)
  loop
    if v_operation->>'op' = 'update' then
      v_item_id := (v_operation->>'itinerary_item_id')::uuid;
      v_patch := v_operation->'patch';
      update public.itinerary_items
      set
        planned_start = case when v_patch ? 'planned_start' then (v_patch->>'planned_start')::timestamptz else planned_start end,
        planned_end = case when v_patch ? 'planned_end' then (v_patch->>'planned_end')::timestamptz else planned_end end,
        status = case when v_patch ? 'status' then (v_patch->>'status')::public.itinerary_status else status end,
        flexibility = case when v_patch ? 'flexibility' then (v_patch->>'flexibility')::public.flexibility_level else flexibility end,
        priority = case when v_patch ? 'priority' then (v_patch->>'priority')::smallint else priority end,
        notes = case when v_patch ? 'notes' then v_patch->>'notes' else notes end
      where id = v_item_id;
    else
      insert into public.itinerary_items (
        id, trip_id, place_id, title, item_type, planned_start, planned_end,
        timezone, flexibility, priority, status, notes, metadata
      ) values (
        (v_operation->'item'->>'id')::uuid,
        v_proposal.trip_id,
        (v_operation->'item'->>'place_id')::uuid,
        v_operation->'item'->>'title',
        coalesce(v_operation->'item'->>'item_type', 'activity'),
        (v_operation->'item'->>'planned_start')::timestamptz,
        (v_operation->'item'->>'planned_end')::timestamptz,
        v_operation->'item'->>'timezone',
        coalesce((v_operation->'item'->>'flexibility')::public.flexibility_level, 'flexible'),
        coalesce((v_operation->'item'->>'priority')::smallint, 3),
        coalesce((v_operation->'item'->>'status')::public.itinerary_status, 'planned'),
        v_operation->'item'->>'notes',
        coalesce(v_operation->'item'->'metadata', '{}'::jsonb)
      );
    end if;
  end loop;

  v_committed_at := clock_timestamp();
  update public.itinerary_change_proposals
  set status = 'committed', committed_at = v_committed_at
  where id = v_proposal.id;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
    into v_changed_items from public.itinerary_items i where i.id = any(v_changed_ids);
  select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
    into v_added_items from public.itinerary_items i where i.id = any(v_added_ids);

  return jsonb_build_object(
    'proposal_id', v_proposal.id,
    'status', 'committed',
    'committed_at', v_committed_at,
    'changed_items', v_changed_items,
    'added_items', v_added_items,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.commit_itinerary_change_proposal(uuid, uuid) from public;
grant execute on function public.commit_itinerary_change_proposal(uuid, uuid)
  to authenticated, service_role;
