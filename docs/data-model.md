# Data model

## Core entities

### `profiles`
Application profile linked 1:1 to `auth.users`.

### `trips`
Top-level trip. Owns dates, timezone, status, destination summary, and default privacy.

### `trip_members`
Shared access model: owner/editor/viewer.

### `places`
Canonical place identity: name, category, provider IDs, address, and PostGIS point.

### `trip_places`
Relationship between a trip and a place: shortlist, planned, visited, rejected. A place is shortlisted until it is scheduled, visited, or ruled out.

### `itinerary_items`
Planned and actual timeline data. Has flexibility (`fixed`, `semi_flexible`, `flexible`) and status.

### `reservations`
Reservation facts and confirmation metadata. Consequential external cancellation/purchase actions are intentionally out of scope for v0.1.

### `place_visits`
Firsthand experience record. Stores actual timing, rating, return intent, and recommendation level. `metadata` exists only to carry a `client_op_id` for idempotent offline replay.

### `journal_entries`
Raw note is preserved. AI-generated summaries are separate. Supports private/trip/shareable visibility.

### `research_items` / `research_sources`
Atomic sourced findings with freshness and provenance. `embedding` is optional.

### `memories` / `memory_evidence`
Semantic memory. Separates explicit, inferred, and imported memories; tracks confidence and status. `embedding` is optional.

### `recommendations`
Reusable recommendation record. Provenance differentiates firsthand vs research.

### `current_trip_state`
Latest ephemeral context for concierge behavior: current itinerary item, last location, observed time, and running-late estimate.

This remains one row per trip. Location updates replace `last_location`; there is no passive location-history entity.

### `itinerary_change_proposals`
Reviewable, non-authoritative itinerary diffs with creator, validation, expiry, status, and optimistic concurrency versions. A transaction-scoped database function is the only direct update path and commits all operations or none.

### `media_assets`
Metadata for Supabase Storage objects. The binary objects remain in Storage.

### `share_guides` / `share_guide_items`
Private draft structure for future curated friend-facing guides. Public sharing policies are intentionally not enabled in v0.1.

## Offline replay keys

`journal_entries`, `places`, `memories`, and `place_visits` each carry a partial unique index on `metadata->>'client_op_id'`, scoped to the writer. They are inert for interactive callers and exist so a companion app replaying a queued write after a lost response cannot create a second row. See `docs/companion-pwa.md`.

## Embeddings

`research_items.embedding` and `memories.embedding` use an unconstrained `vector` column so an embedding model can be chosen later. This avoids making v0.1 depend on an OpenAI API or a fixed embedding dimension.

Once the embedding provider/dimension is chosen, add dimension-specific indexes or migrate to a fixed `vector(n)` column.
