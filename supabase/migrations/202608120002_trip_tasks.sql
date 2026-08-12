-- Untimed planning work for a trip. Tasks are deliberately separate from itinerary items:
-- a passport renewal or booking reminder belongs to the plan, but not on the trip timeline.

create table public.trip_tasks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  notes text,
  due_date date,
  date_kind text not null default 'due',
  completed_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete cascade,
  completed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_tasks_title_present check (btrim(title) <> ''),
  constraint trip_tasks_date_kind check (date_kind in ('due', 'opens')),
  constraint trip_tasks_completion_pair check (
    (completed_at is null and completed_by is null) or
    (completed_at is not null and completed_by is not null)
  )
);

create index trip_tasks_trip_due_idx
  on public.trip_tasks(trip_id, due_date nulls last, created_at)
  where completed_at is null;

create trigger trip_tasks_set_updated_at
  before update on public.trip_tasks
  for each row execute function public.set_updated_at();

alter table public.trip_tasks enable row level security;

create policy trip_tasks_member_select
  on public.trip_tasks for select
  using (public.is_trip_member(trip_id));

create policy trip_tasks_editor_insert
  on public.trip_tasks for insert
  with check (created_by = auth.uid() and public.can_edit_trip(trip_id));

create policy trip_tasks_editor_update
  on public.trip_tasks for update
  using (public.can_edit_trip(trip_id))
  with check (public.can_edit_trip(trip_id));

create policy trip_tasks_editor_delete
  on public.trip_tasks for delete
  using (public.can_edit_trip(trip_id));
