# Companion PWA (offline trip reference)

Status: design proposal. Nothing here is built yet.

## The problem this solves

The dashboard is an MCP App: it renders inside a Claude host, so it needs Claude, which needs a
connection. The Hong Kong trip (Dec 2026 – Jan 2027) includes Guangzhou, Macau, and Guilin — places
where roaming data is unreliable and `claude.ai` may not be reachable at all. On a train to Guilin
the traveller does not need a planner. They need to know which platform, what the hotel address is
in Chinese, and what the confirmation code was.

So the companion app is a **reference and a capture device**, not a second brain. It must be fully
useful with the radio off, and it must never make the traveller wonder whether what they are
looking at is real.

## Principles

1. **Travel Brain stays authoritative.** The PWA holds a cache and a queue. It never derives a new
   fact, resolves a conflict by guessing, or becomes the place a memory lives.
2. **Offline reads are the product.** Capture is the convenience layer. Phase 1 ships read-only and
   is already worth carrying.
3. **No reasoning offline.** Every offline write either appends something new or records something
   that already happened. Anything needing judgement is parked for Claude, not approximated.
4. **Staleness is always visible.** The app says "synced 3h ago" on every screen. This is the same
   discipline `get_current_context` already applies to location with `fresh`/`stale`/`missing`.
5. **The traveller's words always survive.** If a queued write can no longer be attached to what it
   pointed at, the pointer is what gets dropped — never the note.

## Shape

Three layers, each small.

```
  ┌─────────────────────────────────────────────────────────┐
  │ PWA (same origin as the MCP server, /app)               │
  │                                                          │
  │   snapshot ──► local read models ──► Now / Day / Places │
  │  (IndexedDB)   (day grouping, now/next,   / Capture      │
  │       ▲         overlaps, nearby)              │         │
  │       │                                        ▼         │
  │       │                                    outbox        │
  │       │                                  (IndexedDB)     │
  └───────┼────────────────────────────────────────┼─────────┘
          │ one tool call                          │ replay, FIFO
          ▼                                        ▼
        get_offline_snapshot                 existing write tools
          └──────────────── /mcp (OAuth) ──────────┘
```

### 1. Snapshot — one round trip

`get_trip` already returns the entire bundle in a single call: trip, itinerary, reservations,
trip_places with joined places, visits, journal, research with sources, recommendations. On a
two-bar connection, one request that either succeeds or does not is worth far more than seven
chatty ones, so the sync protocol is essentially already designed.

Four gaps to close, in a new read-only `get_offline_snapshot({ trip_id })` that wraps `getTrip`:

- **Coordinates.** `places.location` is a PostGIS geography; PostgREST hands it back as EWKB hex and
  nothing client-side can read it. Distances are computed exclusively server-side today
  (`nearby_trip_places`). Select `st_y(location::geometry)` / `st_x(location::geometry)` into
  explicit `latitude`/`longitude` so the phone can do its own haversine and build map deep links.
- **Lessons and preferences.** `get_trip_lessons` is a separate call, and dietary constraints and
  accessibility needs are exactly what you want offline.
- **`current_trip_state`.** Not in `getTrip`; cheap to include, and lets the app show a pending
  proposal read-only.
- **`server_time` and `snapshot_etag`** (max `updated_at` across tables plus row counts). The etag
  lets a re-sync skip rewriting the store; `server_time` lets the client detect a badly wrong device
  clock, which is a real hazard when crossing into a new zone.

Size is a non-issue: ~15 days × a handful of items, ~60 places, research and journal rows measured
in hundreds — a few hundred KB of JSON, well under any storage limit. No pagination, no incremental
sync, no delta protocol. Fetch the whole trip. Revisit only if the journal grows into megabytes.

Cache the active trip, plus the trip list (tiny). Not every trip.

### 2. Local read models — derive, don't cache the derivation

Cache the **normalized rows** and re-derive the views on the phone. Caching `get_today`'s output
instead would go wrong the moment the clock passes local midnight, or the moment the traveller marks
something done offline — the cached day would keep insisting on yesterday.

`getToday` is already a thin deterministic function over exactly the rows in the snapshot: filter by
local date in the trip zone, sort, find overlaps, compute now/next/then. The pieces to port are
`localDateTime`, `sortedTimeline`, `overlapIssues`, `schedulePosition`, `researchFreshness`, plus a
haversine for nearby.

`instants.mjs` is pure `Intl` and `Date` — it runs unmodified in a browser. That suggests the right
move: extract the timezone and derivation logic into a shared module consumed by the server, the
dashboard, and the PWA. Duplicating it is how the phone and the dashboard start disagreeing about
which day an 11:40pm ferry belongs to.

### 3. Outbox — durable, ordered, idempotent

Every capture writes an entry `{ op_id, kind, payload, created_at, attempts, last_error }` to
IndexedDB and updates the local view optimistically. Replay is FIFO, one at a time, triggered by app
open, `visibilitychange`, the `online` event, and a manual "Sync now". Not Background Sync — iOS
Safari does not have it.

**Which edits are allowed offline.** The test: it belongs offline if it records something that
already happened or the traveller's own intent, it cannot conflict in a way that loses information,
and it needs nothing the phone does not know.

| Action | Tool | Why it is safe |
|---|---|---|
| Mark done / skip, with actual start/end | `update_itinerary_item` | Records what happened; planned timing untouched |
| Journal note | `record_journal_note` | Append-only, cannot conflict |
| Rate a place just left (rating, would return, note) | `mark_place_visited` | One visit per trip+place; last write wins on the traveller's own fields |
| Save a place stumbled upon (name, note, device GPS) | `add_place` | Append-only; GPS works with no network |
| Remember a preference | `remember_preference` | Append-only, `explicit` provenance |

**Online-only, never queued:** `update_current_trip_state`. Location and running-late are ephemeral
by definition — a queued "I am here now" delivered four hours later is a false statement. Send it if
there is a connection, drop it otherwise (a TTL matching `LOCATION_FRESHNESS_MINUTES`).

**Online-only, deliberately:** committing an itinerary proposal. `commit_itinerary_change` is
staleness-checked against `expected_updated_at`; approving a six-hour-old proposal from a cached
snapshot is precisely the case that check exists to catch. The PWA can *show* a pending proposal
offline and refuses to approve one without a fresh read.

**Not offline at all:** moving items, adding scheduled items, finding alternatives, research,
anything with a judgement in it. Instead the app keeps an **"ask Claude" list** — the question plus
its trip/item context — and when back online offers a prepared prompt to hand over. The app never
pretends to answer it.

### Idempotency (needs a server change)

`update_itinerary_item` and `mark_place_visited` are naturally idempotent — replaying them sets the
same fields again. `record_journal_note`, `add_place`, and `remember_preference` are not. A response
lost after the server committed means the retry writes a second copy, which on a flaky connection is
how you end up with every journal note duplicated.

Fix: accept an optional `client_op_id` on those three tools, store it in the existing `metadata`
column, add a partial unique index, and return the existing row on conflict. The alternative —
letting the client choose the primary key and upserting — is fewer moving parts but a bigger change
to the write path, and `client_op_id` doubles as an audit trail of which device wrote what.

### Conflicts

Rare by construction, since everything queued is an append or a record of the past. The one real
case: Claude moved or deleted the item while the phone was dark.

- Item gone, and the queued write is a **status/actual-time update** → cannot be replayed. Move it
  to a "needs attention" list showing what was recorded and what happened. Never silently dropped,
  never re-pointed at a different item by guesswork.
- Item gone, and the queued write is a **journal note** → strip the `itinerary_item_id` and save the
  note. The words are the valuable part.
- Offline-created place referenced by a later visit or note → the outbox keeps a local→server id
  map and rewrites the dependency after `add_place` returns. This is the only ordering dependency
  worth supporting; FIFO handles the rest.

## Authentication

This is the fiddliest part, and it is worth getting right once.

`/mcp` requires a Supabase OAuth 2.1 access token — the verifier demands `client_id`, the
`.../auth/v1` issuer, and the `authenticated` role. A plain Supabase Auth session token does **not**
satisfy that, so the PWA has to be a real OAuth client, not just a signed-in web page.

- **Register the PWA as an OAuth client** (or use dynamic registration, README step 5) with an exact
  redirect URI, and run authorization-code + PKCE. Reuses `/oauth/consent` and the Google sign-in
  already configured.
- **Serve it from the same origin**, at `/app` on the Fly app. No CORS, no new `ALLOWED_ORIGINS`
  entry, service-worker scope covers the whole origin, and the existing Supabase Site URL and
  redirect configuration keeps working. This does add the first static-file route to the server;
  the shell is public (it holds no secrets) and Host validation still applies.
- **Offline must never be gated on a token.** Reading the cache requires no auth check at all. An
  expired access token blocks sync and replay, nothing else. Getting this backwards — a login wall
  in front of cached data — would defeat the entire app.
- **Refresh tokens live in IndexedDB** (not `localStorage`), with a strict CSP like the consent page
  already uses, `connect-src` limited to self plus the Supabase origin for token exchange.

**Be honest about the exposure:** the whole trip, including private journal entries, sits in
plaintext IndexedDB on a phone. Encrypting it needs a passphrase on every open, which destroys the
glanceable-while-walking use case this app exists for. The proportionate answer is device lock plus
an explicit **"Forget this device"** that wipes IndexedDB and revokes the refresh token — not
theatre that makes the app worse. Worth a line in `docs/security.md` when this ships.

## Screens

Four tabs. It should feel like a boarding pass, not a workspace.

1. **Now** — current / next / then in large type, walking-distance saved places, the rest of today's
   timeline, running-late state. The screen you open one-handed.
2. **Day** — swipe between days; tap an item for notes, the place address, the reservation
   confirmation code, and research findings attached to that place.
3. **Places** — the cached list with local filter and search (plain `Array.filter` over the
   snapshot, no server needed), grouped by area or category, each with address and a map deep link.
4. **Capture** — one large text box → journal note, optionally attached to the current item or
   place, optionally with GPS. Plus rate-the-place-I-just-left.

Sync status lives in the header and opens a sheet: last sync, pending writes, failed writes, the
"ask Claude" list.

One cheap win specific to this trip: a `metadata.address_local` convention on places, showing the
address in Chinese characters to hand to a taxi driver. Pure reference data, entirely offline, and
the kind of thing that justifies the app on its own.

**Add to Home Screen is load-bearing, not a nicety.** iOS evicts IndexedDB for sites unused for
seven days unless the app is installed. Onboarding has to insist on it.

## Sequencing

- **Phase 0 (server).** `get_offline_snapshot` with coordinates, lessons, and trip state;
  `client_op_id` on the three append tools; static route at `/app`; register the OAuth client.
- **Phase 1 (read-only PWA).** OAuth, snapshot, IndexedDB, the four screens, local search, staleness
  banner, install prompt. This is the whole ask — offline reference — and it ships alone.
- **Phase 2 (capture).** Outbox, the five safe writes, needs-attention list.
- **Phase 3.** "Ask Claude" handoff, photos into Supabase Storage, pending-proposal display.

Phase 1 before the trip. Phase 2 is convenience.

## Deliberately not building

Offline maps or tiles. Any model in the app. Multi-trip sync. Editing planned times offline. A
second MCP service, a frontend database, or any service credential in the browser — the same
boundaries `docs/architecture.md` already draws for the dashboard.

## The cheaper alternative, for the record

If the PWA does not make it before departure: have Claude generate a static, self-contained HTML
trip sheet — timeline, addresses, confirmation codes — and save it to the phone. No auth, no sync,
no capture, and it goes stale the moment anything changes. But it is an afternoon of work instead of
a project, it works anywhere, and it covers the panic cases. Worth keeping as the fallback even
after the PWA exists.
