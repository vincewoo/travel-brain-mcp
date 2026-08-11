-- Offline companion support.
--
-- Two things the companion PWA needs that the existing surface cannot express.
--
-- 1. Coordinates. `places.location` is a PostGIS geography, and PostgREST serialises it as EWKB
--    hex, which nothing client-side can read. Every distance today is computed inside
--    `nearby_trip_places`, so a phone with no connection cannot answer "what is near me" at all.
--    This function is the same join that read models already do, with the point decomposed into
--    plain latitude/longitude so the cached snapshot can carry it.
--
-- 2. Idempotent replay. A queued offline write whose response is lost on a bad connection gets
--    retried, and `record_journal_note`, `add_place`, `remember_preference`, and
--    `mark_place_visited` all insert unconditionally — the retry would duplicate the row. The
--    tools now accept an optional caller-generated `client_op_id` in `metadata`; these indexes
--    make the second write of the same operation fail loudly instead of quietly duplicating a
--    journal entry. A duplicate visit is not only clutter: a visit is the evidence a `firsthand`
--    recommendation is checked against, and `place_visits` had no `metadata` column to key on.

create or replace function public.trip_offline_places(p_trip_id uuid)
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

-- Scoped to the writer, not globally: two travellers can generate the same client id without
-- colliding, and a replayed write can only ever match the operation the same actor queued.
create unique index journal_entries_client_op_idx
  on public.journal_entries (trip_id, author_id, (metadata ->> 'client_op_id'))
  where (metadata ->> 'client_op_id') is not null;

create unique index places_client_op_idx
  on public.places (created_by, (metadata ->> 'client_op_id'))
  where (metadata ->> 'client_op_id') is not null;

create unique index memories_client_op_idx
  on public.memories (owner_id, (metadata ->> 'client_op_id'))
  where (metadata ->> 'client_op_id') is not null;

alter table public.place_visits
  add column metadata jsonb not null default '{}'::jsonb;

create unique index place_visits_client_op_idx
  on public.place_visits (trip_id, place_id, (metadata ->> 'client_op_id'))
  where (metadata ->> 'client_op_id') is not null;
