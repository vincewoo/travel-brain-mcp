# MCP tool contract

## Read tools

### `list_trips`
Find trips the current actor owns or belongs to.

### `get_trip`
Return trip details plus itinerary, places, reservations, visits, journal entries, research, and recommendations.

### `search_travel_brain`
Search semantic memories, research findings, journal notes, and recommendations. v0.1 is lexical; vector retrieval is a later drop-in enhancement.

## Write tools

### `create_trip`
Create a trip and owner membership.

### `add_place`
Create a canonical place and optionally attach it to a trip.

### `add_itinerary_item`
Schedule an item with planned timing and flexibility.

### `update_itinerary_item`
Update planned/actual timing, status, flexibility, priority, or notes. Does not erase the distinction between planned and actual.

### `save_research_finding`
Store an atomic research finding plus zero or more sources.

### `record_journal_note`
Preserve an on-the-fly raw note with optional place/activity context.

### `mark_place_visited`
Record firsthand visit state, rating, return intent, and optional note.

### `remember_preference`
Write semantic memory with provenance/confidence/status.

### `recommend_place`
Create a reusable recommendation. `firsthand` requires a recorded visit.

## Safety and confirmation

v0.1 tools only mutate the Travel Brain. They do not buy tickets, cancel reservations, send messages, or change external systems.

Later external/consequential actions should use separate tools such as `propose_reservation_change` and `commit_reservation_change`, with explicit confirmation before the commit step.
