-- RLS helpers and policies

create or replace function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.owner_id = auth.uid()
  ) or exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id and tm.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.owner_id = auth.uid()
  ) or exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'editor')
  );
$$;

revoke all on function public.is_trip_member(uuid) from public;
revoke all on function public.can_edit_trip(uuid) from public;
grant execute on function public.is_trip_member(uuid) to authenticated;
grant execute on function public.can_edit_trip(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.places enable row level security;
alter table public.trip_places enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.reservations enable row level security;
alter table public.place_visits enable row level security;
alter table public.journal_entries enable row level security;
alter table public.research_items enable row level security;
alter table public.research_sources enable row level security;
alter table public.memories enable row level security;
alter table public.memory_evidence enable row level security;
alter table public.recommendations enable row level security;
alter table public.current_trip_state enable row level security;
alter table public.media_assets enable row level security;
alter table public.share_guides enable row level security;
alter table public.share_guide_items enable row level security;

create policy profiles_self_select on public.profiles for select using (id = auth.uid());
create policy profiles_self_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_self_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy trips_member_select on public.trips for select using (public.is_trip_member(id));
create policy trips_owner_insert on public.trips for insert with check (owner_id = auth.uid());
create policy trips_editor_update on public.trips for update using (public.can_edit_trip(id)) with check (public.can_edit_trip(id));
create policy trips_owner_delete on public.trips for delete using (owner_id = auth.uid());

create policy trip_members_member_select on public.trip_members for select using (public.is_trip_member(trip_id));
create policy trip_members_owner_insert on public.trip_members for insert with check (
  exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
);
create policy trip_members_owner_update on public.trip_members for update using (
  exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
);
create policy trip_members_owner_delete on public.trip_members for delete using (
  exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
);

create policy places_related_select on public.places for select using (
  created_by = auth.uid() or exists (
    select 1 from public.trip_places tp
    where tp.place_id = id and public.is_trip_member(tp.trip_id)
  )
);
create policy places_creator_insert on public.places for insert with check (created_by = auth.uid());
create policy places_creator_update on public.places for update using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy places_creator_delete on public.places for delete using (created_by = auth.uid());

create policy trip_places_member_select on public.trip_places for select using (public.is_trip_member(trip_id));
create policy trip_places_editor_insert on public.trip_places for insert with check (public.can_edit_trip(trip_id));
create policy trip_places_editor_update on public.trip_places for update using (public.can_edit_trip(trip_id)) with check (public.can_edit_trip(trip_id));
create policy trip_places_editor_delete on public.trip_places for delete using (public.can_edit_trip(trip_id));

create policy itinerary_member_select on public.itinerary_items for select using (public.is_trip_member(trip_id));
create policy itinerary_editor_insert on public.itinerary_items for insert with check (public.can_edit_trip(trip_id));
create policy itinerary_editor_update on public.itinerary_items for update using (public.can_edit_trip(trip_id)) with check (public.can_edit_trip(trip_id));
create policy itinerary_editor_delete on public.itinerary_items for delete using (public.can_edit_trip(trip_id));

create policy reservations_member_select on public.reservations for select using (public.is_trip_member(trip_id));
create policy reservations_editor_insert on public.reservations for insert with check (public.can_edit_trip(trip_id));
create policy reservations_editor_update on public.reservations for update using (public.can_edit_trip(trip_id)) with check (public.can_edit_trip(trip_id));
create policy reservations_editor_delete on public.reservations for delete using (public.can_edit_trip(trip_id));

create policy visits_member_select on public.place_visits for select using (public.is_trip_member(trip_id));
create policy visits_editor_insert on public.place_visits for insert with check (public.can_edit_trip(trip_id));
create policy visits_editor_update on public.place_visits for update using (public.can_edit_trip(trip_id)) with check (public.can_edit_trip(trip_id));
create policy visits_editor_delete on public.place_visits for delete using (public.can_edit_trip(trip_id));

create policy journal_select on public.journal_entries for select using (
  author_id = auth.uid() or (visibility <> 'private' and public.is_trip_member(trip_id))
);
create policy journal_insert on public.journal_entries for insert with check (author_id = auth.uid() and public.can_edit_trip(trip_id));
create policy journal_update on public.journal_entries for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy journal_delete on public.journal_entries for delete using (author_id = auth.uid());

create policy research_select on public.research_items for select using (
  owner_id = auth.uid() or (trip_id is not null and public.is_trip_member(trip_id))
);
create policy research_insert on public.research_items for insert with check (
  owner_id = auth.uid() and (trip_id is null or public.can_edit_trip(trip_id))
);
create policy research_update on public.research_items for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy research_delete on public.research_items for delete using (owner_id = auth.uid());

create policy research_sources_select on public.research_sources for select using (
  exists (select 1 from public.research_items r where r.id = research_item_id and (r.owner_id = auth.uid() or (r.trip_id is not null and public.is_trip_member(r.trip_id))))
);
create policy research_sources_insert on public.research_sources for insert with check (
  exists (select 1 from public.research_items r where r.id = research_item_id and r.owner_id = auth.uid())
);
create policy research_sources_update on public.research_sources for update using (
  exists (select 1 from public.research_items r where r.id = research_item_id and r.owner_id = auth.uid())
);
create policy research_sources_delete on public.research_sources for delete using (
  exists (select 1 from public.research_items r where r.id = research_item_id and r.owner_id = auth.uid())
);

create policy memories_owner_select on public.memories for select using (owner_id = auth.uid());
create policy memories_owner_insert on public.memories for insert with check (owner_id = auth.uid() and (trip_id is null or public.is_trip_member(trip_id)));
create policy memories_owner_update on public.memories for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy memories_owner_delete on public.memories for delete using (owner_id = auth.uid());

create policy memory_evidence_owner_select on public.memory_evidence for select using (
  exists (select 1 from public.memories m where m.id = memory_id and m.owner_id = auth.uid())
);
create policy memory_evidence_owner_insert on public.memory_evidence for insert with check (
  exists (select 1 from public.memories m where m.id = memory_id and m.owner_id = auth.uid())
);
create policy memory_evidence_owner_update on public.memory_evidence for update using (
  exists (select 1 from public.memories m where m.id = memory_id and m.owner_id = auth.uid())
);
create policy memory_evidence_owner_delete on public.memory_evidence for delete using (
  exists (select 1 from public.memories m where m.id = memory_id and m.owner_id = auth.uid())
);

create policy recommendations_member_select on public.recommendations for select using (public.is_trip_member(trip_id));
create policy recommendations_author_insert on public.recommendations for insert with check (author_id = auth.uid() and public.can_edit_trip(trip_id));
create policy recommendations_author_update on public.recommendations for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy recommendations_author_delete on public.recommendations for delete using (author_id = auth.uid());

create policy current_state_member_select on public.current_trip_state for select using (public.is_trip_member(trip_id));
create policy current_state_editor_insert on public.current_trip_state for insert with check (updated_by = auth.uid() and public.can_edit_trip(trip_id));
create policy current_state_editor_update on public.current_trip_state for update using (public.can_edit_trip(trip_id)) with check (updated_by = auth.uid() and public.can_edit_trip(trip_id));
create policy current_state_editor_delete on public.current_trip_state for delete using (public.can_edit_trip(trip_id));

create policy media_member_select on public.media_assets for select using (owner_id = auth.uid() or public.is_trip_member(trip_id));
create policy media_owner_insert on public.media_assets for insert with check (owner_id = auth.uid() and public.can_edit_trip(trip_id));
create policy media_owner_update on public.media_assets for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy media_owner_delete on public.media_assets for delete using (owner_id = auth.uid());

create policy guides_owner_select on public.share_guides for select using (owner_id = auth.uid());
create policy guides_owner_insert on public.share_guides for insert with check (owner_id = auth.uid());
create policy guides_owner_update on public.share_guides for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy guides_owner_delete on public.share_guides for delete using (owner_id = auth.uid());

create policy guide_items_owner_select on public.share_guide_items for select using (
  exists (select 1 from public.share_guides g where g.id = guide_id and g.owner_id = auth.uid())
);
create policy guide_items_owner_insert on public.share_guide_items for insert with check (
  exists (select 1 from public.share_guides g where g.id = guide_id and g.owner_id = auth.uid())
);
create policy guide_items_owner_update on public.share_guide_items for update using (
  exists (select 1 from public.share_guides g where g.id = guide_id and g.owner_id = auth.uid())
);
create policy guide_items_owner_delete on public.share_guide_items for delete using (
  exists (select 1 from public.share_guides g where g.id = guide_id and g.owner_id = auth.uid())
);
