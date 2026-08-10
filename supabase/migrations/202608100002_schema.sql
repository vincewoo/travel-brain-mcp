-- Travel Brain v0.1 schema

create type public.trip_role as enum ('owner', 'editor', 'viewer');
create type public.trip_status as enum ('draft', 'planning', 'active', 'completed', 'archived');
create type public.trip_place_status as enum ('candidate', 'saved', 'planned', 'visited', 'rejected');
create type public.itinerary_status as enum ('planned', 'confirmed', 'in_progress', 'completed', 'skipped', 'cancelled');
create type public.flexibility_level as enum ('fixed', 'semi_flexible', 'flexible');
create type public.recommend_level as enum ('none', 'mixed', 'recommend', 'strongly_recommend', 'avoid');
create type public.journal_visibility as enum ('private', 'trip', 'shareable');
create type public.research_volatility as enum ('static', 'semi_volatile', 'volatile');
create type public.research_status as enum ('active', 'stale', 'superseded');
create type public.memory_status as enum ('candidate', 'confirmed', 'rejected', 'superseded');
create type public.memory_provenance as enum ('explicit', 'inferred', 'imported');
create type public.recommendation_provenance as enum ('firsthand', 'research', 'mixed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  destination_summary text,
  start_date date,
  end_date date,
  timezone text not null default 'UTC',
  status public.trip_status not null default 'draft',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_date_order check (start_date is null or end_date is null or end_date >= start_date)
);

create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.trip_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create table public.places (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  normalized_name text,
  category text,
  address text,
  locality text,
  region text,
  country_code text,
  location extensions.geography(Point, 4326),
  external_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.trip_places (
  trip_id uuid not null references public.trips(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  status public.trip_place_status not null default 'saved',
  priority smallint not null default 3 check (priority between 1 and 5),
  note text,
  first_researched_at timestamptz,
  last_researched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (trip_id, place_id)
);

create table public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  place_id uuid references public.places(id) on delete set null,
  title text not null,
  item_type text not null default 'activity',
  planned_start timestamptz,
  planned_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  timezone text,
  flexibility public.flexibility_level not null default 'flexible',
  priority smallint not null default 3 check (priority between 1 and 5),
  status public.itinerary_status not null default 'planned',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itinerary_planned_order check (planned_start is null or planned_end is null or planned_end >= planned_start),
  constraint itinerary_actual_order check (actual_start is null or actual_end is null or actual_end >= actual_start)
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  itinerary_item_id uuid references public.itinerary_items(id) on delete set null,
  place_id uuid references public.places(id) on delete set null,
  provider text,
  confirmation_code text,
  status text not null default 'confirmed',
  reserved_start timestamptz,
  reserved_end timestamptz,
  party_size integer check (party_size is null or party_size > 0),
  cancellation_deadline timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.place_visits (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  itinerary_item_id uuid references public.itinerary_items(id) on delete set null,
  arrived_at timestamptz,
  departed_at timestamptz,
  rating numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  would_return boolean,
  recommendation public.recommend_level not null default 'none',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visit_time_order check (arrived_at is null or departed_at is null or departed_at >= arrived_at)
);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  itinerary_item_id uuid references public.itinerary_items(id) on delete set null,
  place_id uuid references public.places(id) on delete set null,
  captured_at timestamptz not null default now(),
  raw_note text not null,
  generated_summary text,
  reaction text,
  visibility public.journal_visibility not null default 'private',
  location extensions.geography(Point, 4326),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.research_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete cascade,
  place_id uuid references public.places(id) on delete set null,
  topic text not null,
  finding text not null,
  summary text,
  volatility public.research_volatility not null default 'semi_volatile',
  confidence numeric(3,2) not null default 0.80 check (confidence between 0 and 1),
  status public.research_status not null default 'active',
  valid_as_of timestamptz not null default now(),
  expires_at timestamptz,
  embedding extensions.vector,
  embedding_model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.research_sources (
  id uuid primary key default gen_random_uuid(),
  research_item_id uuid not null references public.research_items(id) on delete cascade,
  source_url text not null,
  source_title text,
  publisher text,
  source_kind text,
  retrieved_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete cascade,
  memory_type text not null,
  content text not null,
  confidence numeric(3,2) not null default 1.00 check (confidence between 0 and 1),
  status public.memory_status not null default 'candidate',
  provenance public.memory_provenance not null default 'explicit',
  evidence_count integer not null default 0 check (evidence_count >= 0),
  embedding extensions.vector,
  embedding_model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_confirmed_at timestamptz
);

create table public.memory_evidence (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete cascade,
  source_type text not null,
  source_record_id uuid,
  evidence_text text,
  created_at timestamptz not null default now()
);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  provenance public.recommendation_provenance not null,
  level public.recommend_level not null default 'recommend',
  shareable_note text,
  caveats text,
  best_for text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.current_trip_state (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  updated_by uuid not null references public.profiles(id) on delete cascade,
  current_itinerary_item_id uuid references public.itinerary_items(id) on delete set null,
  last_location extensions.geography(Point, 4326),
  location_observed_at timestamptz,
  running_late_minutes integer not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  place_id uuid references public.places(id) on delete set null,
  itinerary_item_id uuid references public.itinerary_items(id) on delete set null,
  storage_bucket text not null default 'travel-media',
  storage_path text not null,
  media_type text,
  captured_at timestamptz,
  caption text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table public.share_guides (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'draft',
  public_slug text unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.share_guide_items (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid not null references public.share_guides(id) on delete cascade,
  place_id uuid references public.places(id) on delete set null,
  recommendation_id uuid references public.recommendations(id) on delete set null,
  sort_order integer not null default 0,
  section text,
  custom_note text,
  created_at timestamptz not null default now()
);

create index trips_owner_idx on public.trips(owner_id);
create index trip_members_user_idx on public.trip_members(user_id);
create index places_location_gist on public.places using gist(location);
create index trip_places_status_idx on public.trip_places(trip_id, status);
create index itinerary_trip_time_idx on public.itinerary_items(trip_id, planned_start);
create index visits_trip_place_idx on public.place_visits(trip_id, place_id);
create index journal_trip_time_idx on public.journal_entries(trip_id, captured_at desc);
create index research_trip_place_idx on public.research_items(trip_id, place_id);
create index research_status_valid_idx on public.research_items(status, valid_as_of desc);
create index memories_owner_status_idx on public.memories(owner_id, status);
create index recommendations_trip_place_idx on public.recommendations(trip_id, place_id);
create index current_trip_location_gist on public.current_trip_state using gist(last_location);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger trips_set_updated_at before update on public.trips for each row execute function public.set_updated_at();
create trigger places_set_updated_at before update on public.places for each row execute function public.set_updated_at();
create trigger trip_places_set_updated_at before update on public.trip_places for each row execute function public.set_updated_at();
create trigger itinerary_set_updated_at before update on public.itinerary_items for each row execute function public.set_updated_at();
create trigger reservations_set_updated_at before update on public.reservations for each row execute function public.set_updated_at();
create trigger visits_set_updated_at before update on public.place_visits for each row execute function public.set_updated_at();
create trigger journal_set_updated_at before update on public.journal_entries for each row execute function public.set_updated_at();
create trigger research_set_updated_at before update on public.research_items for each row execute function public.set_updated_at();
create trigger memories_set_updated_at before update on public.memories for each row execute function public.set_updated_at();
create trigger recommendations_set_updated_at before update on public.recommendations for each row execute function public.set_updated_at();
create trigger current_trip_state_set_updated_at before update on public.current_trip_state for each row execute function public.set_updated_at();
create trigger share_guides_set_updated_at before update on public.share_guides for each row execute function public.set_updated_at();
