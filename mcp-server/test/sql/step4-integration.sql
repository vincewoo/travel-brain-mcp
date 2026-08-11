\set ON_ERROR_STOP on

insert into auth.users (id, email, created_at, updated_at) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'editor@example.test', now(), now()),
  ('33333333-3333-4333-8333-333333333333', 'viewer@example.test', now(), now());

insert into public.profiles (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');

insert into public.trips (id, owner_id, title, timezone, status) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Japan', 'Asia/Tokyo', 'active'
);

insert into public.trip_members (trip_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'editor'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'viewer');

insert into public.places (id, created_by, name, category, location) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'Origin cafe', 'cafe', extensions.st_setsrid(extensions.st_makepoint(139, 35), 4326)::extensions.geography),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'Nearby cafe', 'cafe', extensions.st_setsrid(extensions.st_makepoint(139.005, 35), 4326)::extensions.geography),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', '11111111-1111-4111-8111-111111111111', 'Far cafe', 'cafe', extensions.st_setsrid(extensions.st_makepoint(140, 36), 4326)::extensions.geography);

insert into public.trip_places (trip_id, place_id, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'shortlist'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'shortlist'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'shortlist');

insert into public.itinerary_items (
  id, trip_id, title, planned_start, planned_end, actual_start, flexibility, status
) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Lunch', '2026-10-14T03:00:00Z', '2026-10-14T04:00:00Z', '2026-10-14T03:10:00Z', 'flexible', 'planned'),
  ('12121212-1212-4121-8121-121212121212', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Museum', '2026-10-14T05:00:00Z', '2026-10-14T06:00:00Z', null, 'fixed', 'planned');

-- One successful proposal updates an existing item and adds an item with a
-- proposal-stable UUID.
insert into public.itinerary_change_proposals (
  id, trip_id, created_by, summary, operations, validation
)
select
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Move lunch and add coffee',
  jsonb_build_array(
    jsonb_build_object(
      'op', 'update',
      'itinerary_item_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'expected_updated_at', i.updated_at,
      'patch', jsonb_build_object(
        'planned_start', '2026-10-14T04:00:00Z',
        'planned_end', '2026-10-14T05:00:00Z'
      )
    ),
    jsonb_build_object(
      'op', 'add',
      'item', jsonb_build_object(
        'id', '13131313-1313-4131-8131-131313131313',
        'title', 'Coffee',
        'place_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'planned_start', '2026-10-14T06:00:00Z',
        'planned_end', '2026-10-14T06:30:00Z',
        'status', 'planned',
        'flexibility', 'flexible',
        'priority', 3
      )
    )
  ),
  '{}'::jsonb
from public.itinerary_items i
where i.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

do $$
declare
  result jsonb;
  replay jsonb;
begin
  result := public.commit_itinerary_change_proposal(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '11111111-1111-4111-8111-111111111111'
  );
  if result->>'status' <> 'committed' or (result->>'idempotent_replay')::boolean then
    raise exception 'Expected first commit to succeed: %', result;
  end if;
  if not exists (
    select 1 from public.itinerary_items
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      and planned_start = '2026-10-14T04:00:00Z'
      and actual_start = '2026-10-14T03:10:00Z'
  ) then
    raise exception 'Commit did not move planned time while preserving actual time.';
  end if;
  if (select count(*) from public.itinerary_items where id = '13131313-1313-4131-8131-131313131313') <> 1 then
    raise exception 'Commit did not add exactly one stable item.';
  end if;

  replay := public.commit_itinerary_change_proposal(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '11111111-1111-4111-8111-111111111111'
  );
  if not (replay->>'idempotent_replay')::boolean then
    raise exception 'Second commit was not reported as an idempotent replay: %', replay;
  end if;
  if (select count(*) from public.itinerary_items where id = '13131313-1313-4131-8131-131313131313') <> 1 then
    raise exception 'Idempotent replay duplicated the add.';
  end if;
end $$;

-- The first operation is valid and the second stale. The function must detect
-- every stale row before applying either operation.
insert into public.itinerary_change_proposals (
  id, trip_id, created_by, summary, operations, validation
) select
  '14141414-1414-4141-8141-141414141414',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Atomic stale test',
  jsonb_build_array(
    jsonb_build_object(
      'op', 'update',
      'itinerary_item_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'expected_updated_at', (select updated_at from public.itinerary_items where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      'patch', jsonb_build_object('status', 'cancelled')
    ),
    jsonb_build_object(
      'op', 'update',
      'itinerary_item_id', '12121212-1212-4121-8121-121212121212',
      'expected_updated_at', stale_item.updated_at,
      'patch', jsonb_build_object('status', 'cancelled')
    )
  ),
  '{}'::jsonb
from public.itinerary_items stale_item
where stale_item.id = '12121212-1212-4121-8121-121212121212';

-- Simulate an independent UI/chat edit after proposal creation.
update public.itinerary_items
set notes = 'Changed after proposal'
where id = '12121212-1212-4121-8121-121212121212';

do $$
declare result jsonb;
begin
  result := public.commit_itinerary_change_proposal(
    '14141414-1414-4141-8141-141414141414',
    '22222222-2222-4222-8222-222222222222'
  );
  if result->>'error_code' <> 'STALE_PROPOSAL' then
    raise exception 'Expected stale proposal result: %', result;
  end if;
  if exists (
    select 1 from public.itinerary_items
    where id in ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '12121212-1212-4121-8121-121212121212')
      and status = 'cancelled'
  ) then
    raise exception 'A stale proposal partially applied.';
  end if;
end $$;

do $$
begin
  begin
    perform public.commit_itinerary_change_proposal(
      '14141414-1414-4141-8141-141414141414',
      '33333333-3333-4333-8333-333333333333'
    );
    raise exception 'Viewer commit unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);

do $$
declare proposal_count integer;
begin
  select count(*) into proposal_count
  from public.itinerary_change_proposals
  where trip_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if proposal_count <> 2 then
    raise exception 'Viewer could not read trip proposals through RLS.';
  end if;

  begin
    insert into public.itinerary_change_proposals (
      id, trip_id, created_by, summary, operations
    ) values (
      '15151515-1515-4151-8151-151515151515',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '33333333-3333-4333-8333-333333333333',
      'Viewer write',
      '[{"op":"update"}]'::jsonb
    );
    raise exception 'Viewer proposal insert unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

insert into public.current_trip_state (
  trip_id, updated_by, last_location, location_observed_at
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  extensions.st_setsrid(extensions.st_makepoint(139, 35), 4326)::extensions.geography,
  now()
);

update public.current_trip_state
set last_location = extensions.st_setsrid(extensions.st_makepoint(139.1, 35.1), 4326)::extensions.geography
where trip_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

do $$
declare
  nearby_ids uuid[];
begin
  if (select count(*) from public.current_trip_state where trip_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 1 then
    raise exception 'Current location update created history rows.';
  end if;
  select array_agg(place_id order by distance_meters)
    into nearby_ids
  from public.nearby_trip_places(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 35, 139, 1500, 'cafe', null, 25
  );
  if nearby_ids <> array[
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid
  ] then
    raise exception 'Nearby places were not radius-filtered and distance-ordered: %', nearby_ids;
  end if;
end $$;

-- Itinerary removal: planning cruft is deletable, lived rows are not.
insert into public.itinerary_items (id, trip_id, title, planned_start, planned_end, status) values
  ('16161616-1616-4161-8161-161616161616', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Dropped idea', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z', 'cancelled'),
  ('17171717-1717-4171-8171-171717171717', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Journaled stop', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z', 'planned');

insert into public.journal_entries (trip_id, author_id, itinerary_item_id, raw_note) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  '17171717-1717-4171-8171-171717171717',
  'Rain, but the coffee was worth it.'
);

do $$
declare result jsonb;
begin
  -- Actual timings make an item a record of what happened.
  result := public.delete_itinerary_item(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '11111111-1111-4111-8111-111111111111'
  );
  if result->>'error_code' <> 'ITEM_HAS_HISTORY' or not (result->'reasons' ? 'actual_times') then
    raise exception 'Deleting an item with actual timings was not refused: %', result;
  end if;

  -- So does a journal entry pointing at it, whose FK would otherwise be nulled out.
  result := public.delete_itinerary_item(
    '17171717-1717-4171-8171-171717171717',
    '11111111-1111-4111-8111-111111111111'
  );
  if result->>'error_code' <> 'ITEM_HAS_HISTORY' or not (result->'reasons' ? 'journal_entries') then
    raise exception 'Deleting a journaled item was not refused: %', result;
  end if;
  if (select count(*) from public.itinerary_items where id in (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '17171717-1717-4171-8171-171717171717'
  )) <> 2 then
    raise exception 'A refused delete still removed rows.';
  end if;

  -- A viewer cannot delete at all.
  begin
    perform public.delete_itinerary_item(
      '16161616-1616-4161-8161-161616161616',
      '33333333-3333-4333-8333-333333333333'
    );
    raise exception 'Viewer delete unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;

  -- An editor can delete planning cruft outright, and the delete is replay-safe.
  result := public.delete_itinerary_item(
    '16161616-1616-4161-8161-161616161616',
    '22222222-2222-4222-8222-222222222222'
  );
  if result->>'status' <> 'deleted' or (result->>'idempotent_replay')::boolean then
    raise exception 'Editor delete did not report a fresh deletion: %', result;
  end if;
  if exists (select 1 from public.itinerary_items where id = '16161616-1616-4161-8161-161616161616') then
    raise exception 'Deleted itinerary item is still present.';
  end if;

  result := public.delete_itinerary_item(
    '16161616-1616-4161-8161-161616161616',
    '22222222-2222-4222-8222-222222222222'
  );
  if result->>'status' <> 'deleted' or not (result->>'idempotent_replay')::boolean then
    raise exception 'Repeated delete was not reported as an idempotent replay: %', result;
  end if;
end $$;

-- The same removal through a reviewable proposal, atomically with an update.
insert into public.itinerary_change_proposals (
  id, trip_id, created_by, summary, operations, validation
)
select
  '18181818-1818-4181-8181-181818181818',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Drop the museum',
  jsonb_build_array(
    jsonb_build_object(
      'op', 'remove',
      'itinerary_item_id', '12121212-1212-4121-8121-121212121212',
      'expected_updated_at', i.updated_at
    )
  ),
  '{}'::jsonb
from public.itinerary_items i
where i.id = '12121212-1212-4121-8121-121212121212';

-- A removal of a journaled item must be caught at commit time, not just at proposal time.
insert into public.itinerary_change_proposals (
  id, trip_id, created_by, summary, operations, validation
)
select
  '19191919-1919-4191-8191-191919191919',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Drop the journaled stop',
  jsonb_build_array(
    jsonb_build_object(
      'op', 'remove',
      'itinerary_item_id', '17171717-1717-4171-8171-171717171717',
      'expected_updated_at', i.updated_at
    )
  ),
  '{}'::jsonb
from public.itinerary_items i
where i.id = '17171717-1717-4171-8171-171717171717';

do $$
declare result jsonb;
begin
  result := public.commit_itinerary_change_proposal(
    '19191919-1919-4191-8191-191919191919',
    '11111111-1111-4111-8111-111111111111'
  );
  if result->>'error_code' <> 'ITEM_HAS_HISTORY' then
    raise exception 'Committing a removal of a journaled item was not refused: %', result;
  end if;
  if not exists (select 1 from public.itinerary_items where id = '17171717-1717-4171-8171-171717171717') then
    raise exception 'A refused proposal removed the journaled item anyway.';
  end if;

  result := public.commit_itinerary_change_proposal(
    '18181818-1818-4181-8181-181818181818',
    '11111111-1111-4111-8111-111111111111'
  );
  if result->>'status' <> 'committed' then
    raise exception 'Removal proposal did not commit: %', result;
  end if;
  if jsonb_array_length(result->'removed_items') <> 1
    or result->'removed_items'->0->>'title' <> 'Museum' then
    raise exception 'Commit did not report the row it deleted: %', result;
  end if;
  if exists (select 1 from public.itinerary_items where id = '12121212-1212-4121-8121-121212121212') then
    raise exception 'Committed removal left the itinerary item in place.';
  end if;

  result := public.commit_itinerary_change_proposal(
    '18181818-1818-4181-8181-181818181818',
    '11111111-1111-4111-8111-111111111111'
  );
  if not (result->>'idempotent_replay')::boolean
    or jsonb_array_length(result->'removed_items') <> 0
    or result->'removed_item_ids'->>0 <> '12121212-1212-4121-8121-121212121212' then
    raise exception 'Replayed removal commit did not report the deleted ID: %', result;
  end if;
end $$;

-- Offline companion: coordinates and idempotent replay (202608110003_offline_snapshot.sql).

do $$
declare peak record;
begin
  select * into peak
  from public.trip_offline_places('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  where place_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  if peak is null then
    raise exception 'trip_offline_places did not return a saved trip place.';
  end if;
  -- The point was stored as (longitude 139, latitude 35); PostgREST cannot express it at all, so
  -- the whole reason this function exists is that these two columns come back as plain numbers.
  if round(peak.longitude::numeric, 4) <> 139.0000 or round(peak.latitude::numeric, 4) <> 35.0000 then
    raise exception 'trip_offline_places returned the wrong coordinates: % %', peak.latitude, peak.longitude;
  end if;
  if peak.place_name <> 'Origin cafe' or peak.trip_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'trip_offline_places did not join the place row: %', peak;
  end if;

  if exists (
    select 1 from public.trip_offline_places('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    where place_id not in (
      select place_id from public.trip_places
      where trip_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  ) then
    raise exception 'trip_offline_places returned a place outside the trip.';
  end if;
end $$;

do $$
declare duplicated boolean := false;
begin
  insert into public.journal_entries (trip_id, author_id, raw_note, metadata) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Queued in a tunnel',
    '{"client_op_id": "op-replay-1"}'::jsonb
  );

  -- The replay a flaky connection produces. The index is what makes it fail here rather than
  -- silently leaving the traveller with the same note written twice.
  begin
    insert into public.journal_entries (trip_id, author_id, raw_note, metadata) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'Queued in a tunnel',
      '{"client_op_id": "op-replay-1"}'::jsonb
    );
    duplicated := true;
  exception when unique_violation then
    null;
  end;

  if duplicated then
    raise exception 'A replayed journal note was written twice.';
  end if;

  -- A different author reusing the same client id is a different operation, not a duplicate.
  insert into public.journal_entries (trip_id, author_id, raw_note, metadata) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'Same id, different traveller',
    '{"client_op_id": "op-replay-1"}'::jsonb
  );

  -- Notes without a client id are never deduplicated: two identical observations are two memories.
  insert into public.journal_entries (trip_id, author_id, raw_note) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Same words'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Same words');
end $$;

do $$
declare duplicated boolean := false;
begin
  insert into public.place_visits (trip_id, place_id, rating, metadata) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    4.5,
    '{"client_op_id": "op-visit-1"}'::jsonb
  );
  begin
    insert into public.place_visits (trip_id, place_id, rating, metadata) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      4.5,
      '{"client_op_id": "op-visit-1"}'::jsonb
    );
    duplicated := true;
  exception when unique_violation then
    null;
  end;

  if duplicated then
    -- A visit is the evidence a firsthand recommendation is checked against, so a duplicate
    -- overstates the record rather than merely cluttering it.
    raise exception 'A replayed visit was recorded twice.';
  end if;
end $$;

select 'step4 integration passed' as result;
