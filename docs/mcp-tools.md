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

## Step 4 concierge and read-model tools

All responses are returned as MCP `structuredContent` and duplicated as readable JSON text. Every `trip_id` read performs a member check; every write performs an owner/editor check. None of these tools call a live provider.

### `get_today`

Input: `{ trip_id: uuid, date?: YYYY-MM-DD }`. Returns `{ trip, date, timezone, local_time, timeline, reservations, fixed_anchors, visits, alerts, now, next, then }`. Date grouping uses the trip timezone.

### `get_current_context`

Input: `{ trip_id: uuid, at_time?: timestamp }`. Returns `{ trip, local_date, local_time, current_state, location, now, next, then, next_fixed, running_late_minutes, alerts, timeline, pending_proposal }`. `location.status` is always `fresh`, `stale`, or `missing`; freshness defaults to 30 minutes and is configurable with `LOCATION_FRESHNESS_MINUTES`.

### `update_current_trip_state`

Input: `{ trip_id, current_itinerary_item_id?, latitude?, longitude?, location_observed_at?, running_late_minutes?, state? }`. Coordinates must be supplied as a pair. The itinerary item must belong to the trip. The tool updates or inserts the single `current_trip_state` row and avoids a write for identical input.

### `get_nearby_saved_places`

Input: `{ trip_id, latitude? + longitude? | use_current_location: true, radius_meters?: 1500, category?, statuses?, limit?: 10 }`; limit is capped at 25. Returns `{ origin, radius_meters, distance_kind: "geographic", places[] }`. Each result includes canonical place fields, `distance_meters`, trip status/priority, scheduled/visited flags, a stored recommendation, and research freshness. It does not claim routing time, current hours, or wait time.

### `get_plan_overview`

Input: `{ trip_id }`. Returns `{ trip, total_days, scheduled_count, days[], issues[], unscheduled_places[] }`. Deterministic issues cover overlaps, fixed-commitment overlaps, missing planned starts, priority-5 unscheduled places, stale volatile research, and a configured `trip.metadata.minimum_buffer_minutes` when present.

### `get_places_overview`

Input: `{ trip_id, statuses?, category?, researched?, scheduled?, visited?, limit?: 100 }`; limit is capped at 250. Returns `{ places[] }`, where each entry combines canonical/trip-place fields with research count/latest/freshness, itinerary IDs/local dates, visit facts, and stored recommendation provenance.

### `get_recent_journal`

Input: `{ trip_id, limit?: 25, since?, visibility? }`; limit is capped at 100. Returns `{ entries[] }` in descending capture order with authorized linked place/item data. `raw_note` is returned unchanged and is never replaced by `generated_summary`.

### `get_recommendations`

Input: `{ trip_id, provenance?, level?, levels?, place_id?, category?, shareable_only?: false, limit?: 100 }`. `level` is the single-value form and `levels` accepts an array. Returns `{ recommendations[] }` with `{ recommendation, place, visit, research }`. Visit evidence is attached only for firsthand/mixed provenance where present; private journal content is never joined.

### `get_trip_lessons`

Input: `{ trip_id, include_global_preferences?: true }`. Returns stored `{ lessons, preferences }` for the current actor. It preserves memory confidence/status/provenance and performs no synthesis.

### `propose_itinerary_change`

Input:

```json
{
  "trip_id": "uuid",
  "summary": "Move lunch",
  "rationale": "Morning ran late",
  "expires_in_minutes": 60,
  "operations": [
    {
      "op": "update",
      "itinerary_item_id": "uuid",
      "patch": {
        "planned_start": "timestamp",
        "planned_end": "timestamp",
        "status": "planned|confirmed|in_progress|completed|skipped|cancelled",
        "flexibility": "fixed|semi_flexible|flexible",
        "priority": 3,
        "notes": "optional"
      }
    },
    {
      "op": "add",
      "item": {
        "title": "Coffee",
        "place_id": "uuid",
        "item_type": "meal",
        "planned_start": "timestamp",
        "planned_end": "timestamp",
        "timezone": "Asia/Tokyo",
        "flexibility": "flexible",
        "priority": 3,
        "status": "planned",
        "notes": "optional",
        "metadata": {}
      }
    }
  ]
}
```

Returns `{ proposal, diff }`. The stored operations capture `expected_updated_at` for updates and a stable generated ID for adds. The tool never writes `itinerary_items`; actual timestamps and hard deletion are not supported.

### `commit_itinerary_change`

Input: `{ proposal_id: uuid }`. Success returns `{ proposal_id, status: "committed", committed_at, changed_items, added_items, idempotent_replay }`. Stale input returns `{ error_code: "STALE_PROPOSAL", message, changed_item_ids }` with no operations applied. The PostgreSQL RPC is atomic, destructive in MCP annotations because it can move/cancel plans, and idempotent for repeated calls.

## Step 5 MCP App launcher

### `show_travel_dashboard`

Input: `{ trip_id?: uuid, date?: YYYY-MM-DD, view?: "today" | "plan" | "places" | "journal" | "recommendations" }`.

Returns `{ dashboard: { trip_id?, date?, view? } }` and references the `ui://travel-brain/dashboard.html` MCP App resource. `view` deliberately has no schema default: if it is absent, the app chooses a tab from the authoritative trip status (`draft` → Places, `planning` → Plan, `active` → Today, `completed` → Journal, `archived` → Recommendations).

The launcher is read-only. Within the app, Mark Done, Skip, and approved proposal commits call authenticated MCP write tools directly. Optimization, issue repair, place fitting, live food search, freeform memory capture, replanning, and friend-guide generation send a user message to the host model for reasoning.
