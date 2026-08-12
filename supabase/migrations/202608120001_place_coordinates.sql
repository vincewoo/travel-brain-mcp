-- Where a place's coordinates came from.
--
-- `places.location` has been nullable and optional since the beginning, and nothing ever asked for
-- it: `add_place` accepted latitude/longitude but never said what they were for, so every place
-- saved so far has a null point. That was invisible until the companion app tried to draw a map and
-- found nothing to draw.
--
-- Asking the planning agent for coordinates fixes the supply, but it changes what a coordinate
-- means. A point the agent recalled for a well-known landmark is good enough to show which side of
-- the river something is on and not good enough to navigate the last hundred metres with, and this
-- product does not present those as the same thing — the same reason a recommendation carries
-- `provenance` and a research item carries `confidence`. So the point travels with its source, and
-- the map draws an estimate differently from a surveyed fix.
--
-- 'geocoded' is unused today. It is in the constraint so that adding a geocoding path later is a
-- code change rather than another migration against a live table.

alter table public.places
  add column if not exists coordinate_source text;

alter table public.places
  drop constraint if exists places_coordinate_source_check;

alter table public.places
  add constraint places_coordinate_source_check check (
    coordinate_source is null
    or coordinate_source in ('provided', 'estimated', 'geocoded')
  );

-- A source without a point is a claim about nothing, and a point whose origin is unrecorded is the
-- ambiguity this column exists to remove. Both are rejected rather than tidied up on read.
alter table public.places
  drop constraint if exists places_coordinate_source_requires_point;

alter table public.places
  add constraint places_coordinate_source_requires_point check (
    (location is null and coordinate_source is null)
    or (location is not null and coordinate_source is not null)
  );

comment on column public.places.coordinate_source is
  'Where location came from: provided (the caller knew it), estimated (recalled by the agent, approximate), geocoded (looked up). Null exactly when location is null.';

-- Existing rows all have a null location, so the constraint above is already satisfied and there is
-- nothing to backfill. Stated rather than assumed, because a non-null location with no source would
-- have blocked this migration and is worth knowing about before it runs.

-- The companion reads places through this function, so the source has to travel with the point or
-- the phone cannot tell the two apart. A function's OUT columns cannot be changed by CREATE OR
-- REPLACE, so it is dropped and recreated; the body is otherwise the 202608110003 original.
drop function if exists public.trip_offline_places(uuid);

create function public.trip_offline_places(p_trip_id uuid)
returns table (
  trip_id uuid,
  place_id uuid,
  status public.trip_place_status,
  priority smallint,
  note text,
  first_researched_at timestamptz,
  last_researched_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  place_name text,
  normalized_name text,
  category text,
  address text,
  locality text,
  region text,
  country_code text,
  latitude double precision,
  longitude double precision,
  coordinate_source text,
  external_ids jsonb,
  place_metadata jsonb,
  place_created_at timestamptz,
  place_updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    tp.trip_id,
    tp.place_id,
    tp.status,
    tp.priority,
    tp.note,
    tp.first_researched_at,
    tp.last_researched_at,
    tp.created_at,
    tp.updated_at,
    p.name,
    p.normalized_name,
    p.category,
    p.address,
    p.locality,
    p.region,
    p.country_code,
    -- st_y is the latitude and st_x the longitude; the geometry cast is what exposes them.
    extensions.st_y(p.location::extensions.geometry),
    extensions.st_x(p.location::extensions.geometry),
    p.coordinate_source,
    p.external_ids,
    p.metadata,
    p.created_at,
    p.updated_at
  from public.trip_places tp
  join public.places p on p.id = tp.place_id
  where tp.trip_id = p_trip_id;
$$;

revoke all on function public.trip_offline_places(uuid) from public;
grant execute on function public.trip_offline_places(uuid) to authenticated, service_role;
