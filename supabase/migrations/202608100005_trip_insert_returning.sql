-- INSERT ... RETURNING must be able to evaluate ownership from the new row.
-- Calling is_trip_member(id) alone re-queries trips before that row is visible
-- to the statement snapshot, causing a valid owner insert to fail RLS.
drop policy if exists trips_member_select on public.trips;

create policy trips_member_select
on public.trips
for select
using (
  owner_id = auth.uid()
  or public.is_trip_member(id)
);
