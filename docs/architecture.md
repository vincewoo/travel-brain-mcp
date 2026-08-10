# Architecture

## Principle: the database is authoritative

The LLM reasons over travel state; it does not own travel state. A chat transcript is never the canonical itinerary, visit history, research record, or journal.

## System boundaries

### Travel Brain database
Stores durable facts and provenance.

### MCP server
Exposes narrow, goal-oriented operations. It validates authorization and invariants before writes.

Step 4 read models aggregate existing normalized tables into task-shaped responses for Today, Plan, Places, Journal, and Recommendations. They do not introduce dashboard cache tables or call live providers.

Step 5 serves one unified MCP App from the same authenticated server. The browser only keeps transient presentation state such as the selected tab, date, filters, and selected unscheduled places. It reads the Step 4 models, sends explicit deterministic writes back through MCP, and routes optimization or synthesis requests to the host model. There is no second MCP service, frontend database, browser optimizer, or service credential in the UI.

The server has no module-global traveler identity. Auth middleware verifies each HTTP request and tool callbacks resolve a request-scoped `{ actorId, supabase, authInfo }` context. Static staging uses a protected fixed actor and service-role client; production OAuth uses the verified Supabase subject and a user-token client so RLS remains active.

### Planner/concierge agent
Chooses tools and synthesizes answers. It should distinguish firsthand experience from research-only knowledge in every recommendation.

Reasoning-heavy dashboard actions send a user message to the host model. The model may prepare an itinerary proposal, but only an explicit UI confirmation calls `commit_itinerary_change`.

### Future companion app
Reads/writes the same Travel Brain. Location and schedule drift are ephemeral state, not permanent location history by default.

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
