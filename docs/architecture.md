# Architecture

## Principle: the database is authoritative

The LLM reasons over travel state; it does not own travel state. A chat transcript is never the canonical itinerary, visit history, research record, or journal.

## System boundaries

### Travel Brain database
Stores durable facts and provenance.

### MCP server
Exposes narrow, goal-oriented operations. It validates authorization and invariants before writes.

The server has no module-global traveler identity. Auth middleware verifies each HTTP request and tool callbacks resolve a request-scoped `{ actorId, supabase, authInfo }` context. Static staging uses a protected fixed actor and service-role client; production OAuth uses the verified Supabase subject and a user-token client so RLS remains active.

### Planner/concierge agent
Chooses tools and synthesizes answers. It should distinguish firsthand experience from research-only knowledge in every recommendation.

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

## Location privacy

`current_trip_state.last_location` is an ephemeral latest-known position. v0.1 does not create a historical GPS trail. Journal entries and visits may retain a location when deliberately attached to a memory/event.
