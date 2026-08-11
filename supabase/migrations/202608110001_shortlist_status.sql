-- Merge the trip_place_status values 'candidate' and 'saved' into a single 'shortlist'.
-- The two meant the same thing to users and to the read model: db.mjs already treated
-- them as one unscheduled bucket. Postgres cannot drop enum labels, so the type is
-- rebuilt and every dependent object recreated against it.

alter type public.trip_place_status rename to trip_place_status_legacy;

create type public.trip_place_status as enum ('shortlist', 'planned', 'visited', 'rejected');

drop function if exists public.nearby_trip_places(
  uuid, double precision, double precision, double precision, text,
  public.trip_place_status_legacy[], integer
);

alter table public.trip_places
  alter column status drop default,
  alter column status type public.trip_place_status
    using (
      case
        when status::text in ('candidate', 'saved') then 'shortlist'
        else status::text
      end
    )::public.trip_place_status,
  alter column status set default 'shortlist';

drop type public.trip_place_status_legacy;

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
