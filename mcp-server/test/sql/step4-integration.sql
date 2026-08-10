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
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'saved'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'saved'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'saved');

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

select 'step4 integration passed' as result;
