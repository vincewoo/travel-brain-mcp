# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All server commands run from `mcp-server/`:

```bash
npm run check        # node --check on every src module + full test suite (the gate CI runs)
npm test             # node --test test/*.test.mjs
npm run dev          # node --env-file=.env src/server.mjs
npm start            # production entry: src/bootstrap.mjs (cold-start listener, then the real app)
```

Single test file / single test:

```bash
node --test test/tools.test.mjs
node --test --test-name-pattern 'firsthand' test/tools.test.mjs
```

The HTTP integration test binds a loopback port and is skipped unless opted in:

```bash
TRAVEL_BRAIN_NETWORK_TESTS=1 npm test
```

Two separate npm projects under `mcp-server/ui/` must be built before the server tests that assert
on their bundles, and before running the server (the MCP App resource reads the built HTML; `/app`
serves the companion's `dist/`). Like every command here they run from `mcp-server/`, which is what
the `ui/` prefixes below are relative to:

```bash
npm --prefix ui/travel-dashboard ci
npm --prefix ui/travel-dashboard run build   # tsc --noEmit + vite → dist/mcp-app.html (single file)
npm --prefix ui/travel-companion ci
npm --prefix ui/travel-companion run build   # tsc --noEmit + vite → dist/ (shell, worker, manifest)
```

The server starts without either build; the dashboard resource then fails to load and `/app` is not
served (`companion_app=absent` in the log).

Database migrations live in `supabase/migrations/` and are applied in filename order (`supabase db
push`, or pasted into the Supabase SQL editor). They are append-only — add a new timestamped file
rather than editing an applied one. `mcp-server/test/sql/step4-integration.sql` is a fixture to run
against a real Postgres after migrating; it covers PostGIS ordering, proposal commit/staleness,
atomicity, viewer denial, the itinerary-removal history guard, `trip_offline_places` coordinates,
and the `client_op_id` replay indexes.

## Architecture

### The database is authoritative

The LLM reasons over travel state; it does not own it. A chat transcript is never the canonical
itinerary, visit history, or journal. Every tool is a narrow, goal-oriented operation over
Supabase/Postgres, and product invariants are enforced in `db.mjs` and in SQL — not in prompts.

### Request-scoped identity

There is no module-global traveler. `server.mjs` builds a resolver that turns each authenticated
HTTP request into a `{ actorId, supabase, authInfo }` context, memoized per MCP handler instance,
and every tool callback receives it. Two modes (`config.mjs`, `auth.mjs`):

- `static` — a high-entropy `MCP_BEARER_TOKEN` guards a service-role Supabase client acting as a
  fixed `TRAVEL_BRAIN_USER_ID`. RLS is bypassed, so the application-level `tripAccess()` checks in
  `db.mjs` are the only authorization boundary. Local/staging only.
- `supabase_oauth` — Supabase Auth verifies each OAuth 2.1 access token (issuer, `authenticated`
  role, `exp`, `sub`, `client_id`); the verified `sub` becomes the actor and a per-request client
  carries that user JWT, so RLS applies too. The server is a resource server only; it never issues
  tokens. `/oauth/consent` is the Supabase-required approval UI.

Never introduce a shared mutable Supabase client, a module-level actor, or a service-role path
reachable from an unauthenticated route.

### Module layering

- `tools.mjs` — MCP surface only: Zod input schemas, descriptions, and annotations
  (`readOnlyHint`/`destructiveHint`/`idempotentHint`). It delegates immediately to `db.mjs` and
  wraps results in `{ structuredContent, content: [text] }`. Every response is duplicated as
  readable JSON text.
- `db.mjs` — all data access, all authorization (`tripAccess`), all invariants, and the Step 4 read
  models. This is where behavior lives.
- `instants.mjs` — timestamp discipline (see below).
- `trip-clock.mjs` — pure derivations over trip rows: local day/time in a zone, timeline ordering,
  now/next/then, overlap issues, the whole plan-overview issue set (`planIssues`) and day grouping
  (`planDays`), research freshness, haversine. No Supabase, no config, `Intl` and `Date` only, so it
  runs in Node and in a browser. `db.mjs` and the companion PWA import the same file;
  `trip-clock.d.mts` types it for the TypeScript app. Put a new derivation here rather than inline
  in a read model if the companion also needs to compute it offline.
- `mcp-server/ui/shared/` — what the two front ends have in common, imported by both npm projects:
  `travel-brain.css` (the palette, type ramp, and the container/row/status vocabulary),
  `format.ts` (zone-aware time and date labels, flexibility and status tones), and `timeline.ts`
  (where an alert sits in a day). Sizing is tokenised so the dashboard can stay pointer-sized while
  the companion goes thumb-sized without either forking the design. A visual change belongs here
  unless it is genuinely particular to one surface. The dark palette is stated twice — once for
  `prefers-color-scheme: dark`, once for the `[data-theme="dark"]` the companion's appearance
  control sets — because CSS cannot share a declaration block between a media query and a selector;
  `test/companion-theme.test.mjs` fails if the two drift apart.
- `companion-app.mjs` — serves the built companion PWA at `/app` (static shell plus an SPA fallback
  so `/app/callback` can finish the OAuth exchange).
- `dashboard-ui.mjs` — registers the `show_travel_dashboard` tool plus the `ui://travel-brain/
  dashboard.html` MCP App resource, reading the built single-file HTML from `dashboard/` (Docker
  image) or `mcp-server/ui/travel-dashboard/dist/` (repo).
- `bootstrap.mjs` — binds the port immediately during cold start, serves `/health` as `starting`
  and `503` elsewhere, then hands over to the loaded application.

### Read models, not caches

The Step 4 tools (`get_today`, `get_plan_overview`, `get_places_overview`, `get_current_context`,
`get_recent_journal`, `get_recommendations`, `get_trip_lessons`, `get_nearby_saved_places`)
aggregate the same normalized tables into task-shaped responses. There are no dashboard cache
tables and no live provider calls. Day grouping always happens in the trip's timezone.

### Timestamps are on the traveller's clock

A value without an offset (`2026-12-28T09:00`) is a wall-clock time, resolved by `instants.mjs` in
the item's `timezone` falling back to the trip's; a value with an offset or `Z` already names an
instant and passes through untouched. Everything persists as `timestamptz` and renders back in the
trip's zone. Writing a naive timestamp straight to Postgres records it against the session zone
(UTC) and silently moves a 9am Guilin cruise to 5pm — route new timestamp inputs through
`zonedInstant`/`zonedInstants` and describe them with `LOCAL_TIME_HINT`.

### Two-step itinerary changes

Reasoning-derived replans go `propose_itinerary_change` → user approval →
`commit_itinerary_change`. Proposals are non-authoritative rows with `expected_updated_at` versions
and stable pre-generated IDs for adds; the commit is a single security-definer RPC
(`commit_itinerary_change_proposal`) that re-checks access, locks rows, validates an operation
whitelist, and applies everything or nothing. Stale versions return `STALE_PROPOSAL`. Repeated
commits are idempotent.

### The companion PWA is a cache, not a second source of truth

`mcp-server/ui/travel-companion` is an installable offline app served at `/app` on the same origin
as `/mcp`, for the parts of a trip with no usable connection and therefore no Claude. It reads
through one tool, `get_offline_snapshot` (a whole trip in one round trip, rows rather than derived
day views), stores those rows in IndexedDB, and recomputes Today/plan/nearby on the device via
`trip-clock.mjs`. Caching a derived `get_today` instead would be wrong once local midnight passes.

It is the same product as the dashboard and has to look like it: both draw on
`mcp-server/ui/shared/`, so a row, a status dot, a time label, and an empty state read the same on
both surfaces. The companion mirrors the dashboard's views (Now/Today, Plan, Places, Journal with
recommendations) and adds the offline reference sheet the dashboard has no reason to carry —
local-script addresses, confirmation codes, straight-line distance. What it must never mirror is the
dashboard's itinerary writes: every itinerary "Mark done", "Skip" and "Ask Claude" affordance
stays out until the Phase 2 outbox exists. Planning-task checkboxes are the narrow exception: while
connected they call the idempotent `update_trip_task` tool and only update IndexedDB after success.

Maps are the phone's, not the dashboard's, and they degrade rather than disappear: `OfflineMap` is
dependency-free SVG in the shell, drawing true relative positions and a haversine-measured scale bar
with no basemap, and `MapPanel` reaches MapLibre through a dynamic `import()` so the library never
enters the cold-start bundle — a test asserts the split. Tiles are OpenFreeMap, opted into once
(`maps:enabled`), never cached, and never a grey grid when the radio is off. `map-source.mjs` holds
what is known about that basemap without importing the library: the style URL, a zoom ceiling kept
near the tileset's own `maxzoom: 14` so the pinch cannot promise detail that will never arrive, and
the rule deciding when a failing basemap gives way to the schematic. Classify that failure by what
failed — style, tile, glyph — never by matching the error text.

It is its own OAuth 2.1 client; the shell is public and holds no trip data. Phase 1 is offline
read-only apart from connected planning-task checkboxes. Phase 2 adds an outbox limited to writes
that append or record what already happened — the
`client_op_id` idempotency on `add_place`, `record_journal_note`, `mark_place_visited`, and
`remember_preference` exists for that replay. `update_current_trip_state` is deliberately never
queued: a location delivered four hours late is a false statement. See `docs/companion-pwa.md`.

### The dashboard is an MCP App, not a second service

`mcp-server/ui/travel-dashboard` is a React/Vite app inlined to one HTML file and served as an MCP
resource from the same authenticated server. It owns no credentials, no data store, and no second
MCP endpoint: it calls the Step 4 tools through its host (`src/mcp.ts`), keeps only transient
presentation state, and routes anything requiring reasoning to the host model via `app.sendMessage`.
Deterministic writes (Mark Done, Skip, approved commits) call tools directly.

## Invariants that must survive any change

These are enforced in code and asserted in tests; breaking one is a product bug, not a refactor.

- A `firsthand` recommendation requires a recorded visit.
- Planned and actual itinerary timestamps are distinct; actuals never overwrite plans.
- `raw_note` is preserved verbatim; generated prose belongs in `generated_summary`.
- Semantic memory keeps provenance/confidence/status; inferences start as `candidate`.
- Research stays atomic and sourced, with `valid_as_of`, volatility, and freshness.
- `remove_itinerary_item` (and a proposal `remove` op) deletes only history-free plan rows.
  Anything in progress, completed, timed, journaled, visited, reserved, or currently live must be
  `skipped`/`cancelled` instead — the guard lives in the `delete_itinerary_item` function because
  the referencing foreign keys are `on delete set null` and would silently orphan real memories.
- A stored place coordinate always carries its `coordinate_source`, and the two are added and
  removed together — a point that does not say whether it was surveyed or recalled looks surveyed
  on a map. `estimated` is the default for a supplied point, and the companion draws it dashed.
- `current_trip_state.last_location` is one ephemeral point per trip, always returned qualified as
  `fresh`/`stale`/`missing`. Do not add a passive GPS trail.
- Tools mutate Travel Brain only. No purchases, cancellations, or messages to external systems.
- Embeddings stay optional; there is no OpenAI dependency.
- Offline replay keys (`client_op_id`) are scoped per writer, and a replayed append returns the
  original row rather than inserting a second one.

`agent/TRAVEL_AGENT.md` states the matching behavioral contract for the planning/concierge agent.

## Testing approach

`test/support/scripted-supabase.mjs` is a fake Supabase client scripted with an ordered list of
expected `{ table, data }` steps; it asserts the table of every call and records filters, order,
and cardinality. Tests therefore pin the *sequence* of queries a `db.mjs` function makes — changing
or reordering queries will fail tests by design, and the fixture list must be updated alongside.
Tests cover config/auth mapping, owner/editor/viewer authorization, timezone-correct read models,
location freshness, provenance, proposal non-mutation, and the dashboard build.

## Docs

`docs/architecture.md`, `docs/data-model.md`, `docs/mcp-tools.md` (tool contracts),
`docs/security.md` (mode-by-mode threat model), `docs/companion-pwa.md` (offline companion app
design), `examples/vertical-slice.md` (the research → plan → visit → journal → recommend → learn
scenario). The root `README.md` carries the deployment and Supabase/Fly/Google operator procedures.
Keep these in sync when the tool surface or invariants change.
