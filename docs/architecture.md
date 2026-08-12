# Architecture

## Principle: the database is authoritative

The LLM reasons over travel state; it does not own travel state. A chat transcript is never the canonical itinerary, visit history, research record, or journal.

## System boundaries

### Travel Brain database
Stores durable facts and provenance, including untimed trip planning tasks separately from the
scheduled itinerary.

### MCP server
Exposes narrow, goal-oriented operations. It validates authorization and invariants before writes.

Step 4 read models aggregate existing normalized tables into task-shaped responses for Today, Plan, Places, Journal, and Recommendations. They do not introduce dashboard cache tables or call live providers.

Step 5 serves one unified MCP App from the same authenticated server. The browser only keeps transient presentation state such as the selected tab, date, filters, and selected unscheduled places. It reads the Step 4 models, sends explicit deterministic writes back through MCP, and routes optimization or synthesis requests to the host model. There is no second MCP service, frontend database, browser optimizer, or service credential in the UI.

The server has no module-global traveler identity. Auth middleware verifies each HTTP request and tool callbacks resolve a request-scoped `{ actorId, supabase, authInfo }` context. Static staging uses a protected fixed actor and service-role client; production OAuth uses the verified Supabase subject and a user-token client so RLS remains active.

### Planner/concierge agent
Chooses tools and synthesizes answers. It should distinguish firsthand experience from research-only knowledge in every recommendation.

Reasoning-heavy dashboard actions send a user message to the host model. The model may prepare an itinerary proposal, but only an explicit UI confirmation calls `commit_itinerary_change`.

### Companion PWA
An installable offline companion served at `/app` on the same origin as `/mcp`, for the parts of a trip where there is no usable connection and therefore no Claude. It is a cache and, from Phase 2, a capture device — never a second source of truth.

It reads through one tool, `get_offline_snapshot`, and stores the returned rows in IndexedDB. Day grouping, now/next/then, overlap alerts, and nearby distances are recomputed on the device from those rows, using the same `src/trip-clock.mjs` the server's read models use, so the two cannot disagree about which local day an item falls on. Caching a derived `get_today` instead would be wrong by morning. Planning tasks remain readable offline; their checkboxes make a narrow direct `update_trip_task` call when connected and update the cached row after the server accepts the write.

The shell is public and holds no trip data; the app authenticates as its own OAuth 2.1 client and every byte of travel content still arrives through an authenticated MCP call. Location and schedule drift remain ephemeral state, not permanent location history.

## Memory layers

### Structured state
Examples: trip dates, itinerary items, reservations, actual visit times.

### Semantic memory
Examples: explicit food preferences, accessibility constraints, learned travel-style tendencies, lessons from prior trips.

Semantic memory includes provenance, confidence, and confirmation status. Inferences should start as `candidate`; explicit user statements can be stored as `confirmed`.

### Research memory
Research is stored as atomic findings with source links, `valid_as_of`, volatility, and status. The system can reuse stable facts and refresh volatile facts.

## Provenance rule

A recommendation must always be distinguishable as:

- `firsthand`: backed by a recorded visit
- `research`: researched but not personally visited
- `mixed`: synthesis of firsthand experience and external research

The MCP server rejects a `firsthand` recommendation when no visit exists for that place/trip.

## Planned vs actual

Itinerary records include both planned and actual timestamps. Replanning never overwrites history.

Reasoning-derived replans use a two-step workflow: `propose_itinerary_change` stores a reviewable diff without touching the itinerary, and `commit_itinerary_change` applies an approved, non-stale proposal atomically. Adds receive stable IDs at proposal time so repeated commit calls are idempotent.

## Location privacy

`current_trip_state.last_location` is an ephemeral latest-known position. v0.1 does not create a historical GPS trail. Journal entries and visits may retain a location when deliberately attached to a memory/event.
