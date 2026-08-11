-- Removing an itinerary item that never happened is a planning edit, not a record.
--
-- Until now the only way to take an item off the plan was to set status 'cancelled' or
-- 'skipped', which is the right record for a trip that is under way ("we had this, it did
-- not happen") but is pure cruft while planning ("that idea got replaced twice"). This
-- migration adds real deletion for items with no lived history, and keeps the soft
-- statuses as the only option for items that do have history.
--
-- "History" is anything that makes the row evidence rather than intent: actual timings, a
-- lived status, or another table pointing at it (journal, visit, reservation, media, or
-- the live current-item pointer). Those FKs are `on delete set null`, so a delete would
-- silently orphan real memories; the guard refuses instead.

create or replace function public.itinerary_item_history_reasons(p_itinerary_item_id uuid)
returns text[]
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with item as (
    select * from public.itinerary_items where id = p_itinerary_item_id
  )
  select coalesce(array_agg(reason order by reason), '{}'::text[])
  from (
    select 'lived_status' as reason
      where exists (select 1 from item where status in ('in_progress', 'completed'))
    union all
    select 'actual_times'
      where exists (select 1 from item where actual_start is not null or actual_end is not null)
    union all
    select 'journal_entries'
      where exists (select 1 from public.journal_entries where itinerary_item_id = p_itinerary_item_id)
    union all
    select 'place_visits'
      where exists (select 1 from public.place_visits where itinerary_item_id = p_itinerary_item_id)
    union all
    select 'reservations'
      where exists (select 1 from public.reservations where itinerary_item_id = p_itinerary_item_id)
    union all
    select 'media_assets'
      where exists (select 1 from public.media_assets where itinerary_item_id = p_itinerary_item_id)
    union all
    select 'current_trip_state'
      where exists (select 1 from public.current_trip_state where current_itinerary_item_id = p_itinerary_item_id)
  ) reasons;
$$;

revoke all on function public.itinerary_item_history_reasons(uuid) from public;
grant execute on function public.itinerary_item_history_reasons(uuid) to authenticated, service_role;

create or replace function public.delete_itinerary_item(
  p_itinerary_item_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_item public.itinerary_items%rowtype;
  v_reasons text[];
begin
  if p_actor_id is null then
    raise exception using errcode = '42501', message = 'Actor identity is required.';
  end if;

  v_actor_id := coalesce(auth.uid(), p_actor_id);
  if auth.uid() is not null and auth.uid() <> p_actor_id then
    raise exception using errcode = '42501', message = 'Actor identity does not match the authenticated user.';
  end if;

  select * into v_item from public.itinerary_items
  where id = p_itinerary_item_id
  for update;

  -- Deleting an item that is already gone is the requested end state, so repeated calls
  -- report the same success instead of failing the second caller.
  if not found then
    return jsonb_build_object(
      'status', 'deleted',
      'itinerary_item', null,
      'idempotent_replay', true
    );
  end if;

  if not (
    exists (select 1 from public.trips t where t.id = v_item.trip_id and t.owner_id = v_actor_id)
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = v_item.trip_id
        and tm.user_id = v_actor_id
        and tm.role in ('owner', 'editor')
    )
  ) then
    raise exception using errcode = '42501', message = 'Trip access is read-only.';
  end if;

  v_reasons := public.itinerary_item_history_reasons(p_itinerary_item_id);
  if cardinality(v_reasons) > 0 then
    return jsonb_build_object(
      'error_code', 'ITEM_HAS_HISTORY',
      'message', 'This itinerary item has recorded history; cancel or skip it instead of deleting it.',
      'reasons', to_jsonb(v_reasons),
      'itinerary_item', to_jsonb(v_item)
    );
  end if;

  delete from public.itinerary_items where id = p_itinerary_item_id;

  return jsonb_build_object(
    'status', 'deleted',
    'itinerary_item', to_jsonb(v_item),
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.delete_itinerary_item(uuid, uuid) from public;
grant execute on function public.delete_itinerary_item(uuid, uuid) to authenticated, service_role;

-- The proposal commit RPC gains the same removal, so replanning can drop an item in the
-- same reviewable, atomic diff that moves and adds the others. Everything else about the
-- function is unchanged: locking, optimistic versions, and idempotent replay.
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
  v_snapshot jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_changed_ids uuid[] := '{}'::uuid[];
  v_added_ids uuid[] := '{}'::uuid[];
  v_removed_ids uuid[] := '{}'::uuid[];
  v_seen_ids uuid[] := '{}'::uuid[];
  v_stale_ids uuid[] := '{}'::uuid[];
  v_history_ids uuid[] := '{}'::uuid[];
  v_changed_items jsonb := '[]'::jsonb;
  v_added_items jsonb := '[]'::jsonb;
  v_removed_items jsonb := '[]'::jsonb;
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

  select coalesce(array_agg((operation->>'itinerary_item_id')::uuid), '{}'::uuid[])
    into v_removed_ids
  from jsonb_array_elements(v_proposal.operations) operation
  where operation->>'op' = 'remove'
    and operation->>'itinerary_item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  if v_proposal.status = 'committed' then
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
      into v_changed_items from public.itinerary_items i where i.id = any(v_changed_ids);
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
      into v_added_items from public.itinerary_items i where i.id = any(v_added_ids);
    -- Removed rows no longer exist, so a replay reports the IDs it deleted rather than
    -- resurrecting snapshots of them.
    return jsonb_build_object(
      'proposal_id', v_proposal.id,
      'status', 'committed',
      'committed_at', v_proposal.committed_at,
      'changed_items', v_changed_items,
      'added_items', v_added_items,
      'removed_items', '[]'::jsonb,
      'removed_item_ids', to_jsonb(v_removed_ids),
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
  where i.id = any(v_changed_ids || v_removed_ids)
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

    elsif v_operation->>'op' = 'remove' then
      if not (v_operation->>'itinerary_item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
        raise exception 'Remove operation has an invalid itinerary_item_id.';
      end if;
      v_item_id := (v_operation->>'itinerary_item_id')::uuid;
      if v_item_id = any(v_seen_ids) then
        raise exception 'A proposal may touch each itinerary item only once.';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_item_id);

      select * into v_item from public.itinerary_items
      where id = v_item_id and trip_id = v_proposal.trip_id;
      -- An item that is already gone is the end state this operation asks for.
      if not found then
        continue;
      end if;
      if v_operation->>'expected_updated_at' is null
        or v_item.updated_at is distinct from (v_operation->>'expected_updated_at')::timestamptz then
        v_stale_ids := array_append(v_stale_ids, v_item_id);
        continue;
      end if;
      if cardinality(public.itinerary_item_history_reasons(v_item_id)) > 0 then
        v_history_ids := array_append(v_history_ids, v_item_id);
      end if;

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

  if cardinality(v_history_ids) > 0 then
    return jsonb_build_object(
      'error_code', 'ITEM_HAS_HISTORY',
      'message', 'One or more itinerary items have recorded history; cancel or skip them instead of removing them.',
      'changed_item_ids', to_jsonb(v_history_ids)
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
    elsif v_operation->>'op' = 'remove' then
      v_item_id := (v_operation->>'itinerary_item_id')::uuid;
      delete from public.itinerary_items
      where id = v_item_id and trip_id = v_proposal.trip_id
      returning to_jsonb(itinerary_items) into v_snapshot;
      if v_snapshot is not null then
        v_removed_items := v_removed_items || jsonb_build_array(v_snapshot);
      end if;
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
    'removed_items', v_removed_items,
    'removed_item_ids', to_jsonb(v_removed_ids),
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.commit_itinerary_change_proposal(uuid, uuid) from public;
grant execute on function public.commit_itinerary_change_proposal(uuid, uuid)
  to authenticated, service_role;
