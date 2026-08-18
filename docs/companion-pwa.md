# Companion PWA (offline trip reference)

Status: Phase 0, Phase 1 and Phase 2 are built. Phase 3 is still design.

Build and run it with the commands in the root `README.md`; the tool contract is in
`docs/mcp-tools.md` and the device exposure is in `docs/security.md`.

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
2. **Offline reads are the product.** Capture is the convenience layer, and it is built, but a
   phone that only read would still be worth carrying.
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
  │   snapshot ──► local read models ──► Now / Plan / Places │
  │  (IndexedDB)   (day grouping, now/next,  / Journal / Card│
  │       ▲         plan issues, nearby)           │         │
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

`get_trip` already returns the entire bundle in a single call: trip, itinerary, planning tasks,
reservations, trip_places with joined places, visits, journal, research with sources,
recommendations. On a
two-bar connection, one request that either succeeds or does not is worth far more than seven
chatty ones, so the sync protocol is essentially already designed.

Four gaps closed, in a read-only `get_offline_snapshot({ trip_id })` that wraps `getTrip`:

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

`getPlanOverview` is the same kind of function one level up, so `planIssues` (overlaps, items never
placed on a day, high-priority places left unscheduled, stale volatile research, gaps under the
trip's configured buffer) and `planDays` were lifted out of it too.

These all live in `mcp-server/src/trip-clock.mjs`, imported unchanged by both `db.mjs` and the
companion — the module is pure `Intl` and `Date`, so it runs in Node and in a browser without
modification, and a `.d.mts` alongside it gives the TypeScript app its types. One implementation,
two consumers. Duplicating it is how the phone and the dashboard start disagreeing about which day
an 11:40pm ferry belongs to, or about how many things are wrong with a plan.

The presentational half is shared the same way, in `mcp-server/ui/shared/` — see *It has to look
like the dashboard* below.

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

### Idempotency

`update_itinerary_item` is naturally idempotent — replaying it sets the same fields again.
`record_journal_note`, `add_place`, `remember_preference`, and `mark_place_visited` are not: all
four insert. (An earlier draft of this document called `mark_place_visited` idempotent. It is not —
it writes a new `place_visits` row every call, and a duplicate visit is worse than clutter, because
a visit is the evidence a `firsthand` recommendation is checked against.)

Built, and now used: those four tools accept an optional `client_op_id`, stored in the row's `metadata`, with
partial unique indexes scoped per writer. `place_visits` had no `metadata` column and gained one.
The tool looks the operation up first and returns the original row; the index catches the race
where two replays arrive at once. A replay is indistinguishable from the first call, including in
the response — there is no replay flag, because idempotent means the caller should not have to
care.

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

Five tabs. It should feel like a boarding pass, not a workspace.

1. **Now** — the Now bar (current item, what is next, how far behind the day is, elapsed progress)
   over the rest of today's timeline with its alerts inline, then walking-distance saved places.
   The item in progress and the one after it carry their address, local-script address and
   confirmation code without a tap. The screen you open one-handed.
2. **Plan** — planning TODO checkboxes, the whole plan's issues in one list, then every day of the trip in order, each with
   its timeline, the reservations belonging to no item, and the notes written on it. A day you can
   only read one at a time is a plan you cannot check, so the days stack down the page exactly as
   the dashboard renders them, and on a screen wide enough (820px and up — a tablet, a laptop) the
   same day sections turn into columns that scroll horizontally, three or four days at once. The
   day strip across the top is not a filter but the jump: tap a date and its day comes to you. The
   dashboard's unscheduled tray is not mirrored here: nothing on this phone can put a saved place
   onto a day, so a shortlist at the bottom of the plan is only something to look at. The shortlist
   lives in Places, where it can at least be searched and filtered.
3. **Places** — the cached list with local filter and search (plain `Array.filter` over the
   snapshot, no server needed), status chips with live counts and grouping by category, area or
   status, each row carrying address, map deep link, the visit, and the first research findings.
4. **Journal** — raw notes verbatim with their reaction and visit context, then recommendations
   split firsthand / mixed evidence / research only.
5. **Card** — the reference sheet: where you are staying, every reservation and its code,
   dietary constraints, and the lessons this trip has already taught. Plus the device settings:
   appearance, basemap tiles, and Forget this device.

Capture is one sheet, reachable from the sync row, the Now bar and the Journal tab: a note
(optionally attached to the item in progress, a saved place, and the device's position), a rating for
a place just left, a place stumbled upon, and a preference worth remembering. Mark done and Skip sit
on the timeline rows themselves, in Now and in Plan. The rating form refuses a place the trip has
already recorded a visit for and offers the journal instead — a visit is the evidence a `firsthand`
recommendation is checked against, so a second one is a false second sighting rather than clutter.
The task checklist stays a deliberate connected-only write: it is deterministic, requires no Claude
reasoning, and does not claim success until MCP accepts it.

### It has to look like the dashboard

The dashboard and the companion are one product seen from two places, and a traveller who reads
their timeline in Claude and then opens the same trip on a phone should not feel they have changed
applications. So both front ends import `ui/shared/`: `travel-brain.css` carries the palette, the
type ramp and the container/row/status vocabulary, `format.ts` carries every time, date and status
label, and `timeline.ts` decides where an alert sits in a day.

The differences that remain are the ones that are real. Control and type sizes are tokens, so the
companion can go thumb-sized and one notch larger for reading in daylight while the dashboard stays
pointer-sized, without either forking a rule. The companion's shell is a full-height column with a
tab bar pinned under the trip header — at the top rather than under the thumb, because Plan is now
a page as long as the trip and a bar that scrolled away with it would be a bar you have to hunt
for; the dashboard's is a panel sized by its host. And the companion adds what only a
phone needs — an address in local script, a confirmation code set large enough to read aloud, a
straight-line distance.

Light and dark is one more of those real differences. Both surfaces follow the system setting, and
for the dashboard that is the end of it: it is a panel inside a Claude host, and the palette is the
host's business. The companion is a standalone app on a phone, where the system setting is usually
right and occasionally useless — a night bus, a sunlit platform, a screen that has to be readable
at arm's length — so **Card → Appearance** offers System / Light / Dark, and an explicit choice
wins over the phone in both directions. What it does not do is fork the palette: the dark tokens
live in `ui/shared/travel-brain.css` with everything else, stated once for
`prefers-color-scheme: dark` and once for `[data-theme="dark"]` because CSS cannot share a
declaration block between a media query and a selector, with `test/companion-theme.test.mjs`
asserting the two have not drifted apart. `color-scheme` moves with the choice so the checkboxes
and scrollbars the browser draws itself follow the page, the choice is kept in `localStorage`
rather than IndexedDB so an inline script in the shell can apply it before the first paint (an
async read means a white flash on every cold start in a dark room), and `theme-color` is rewritten
alongside it so the status bar is not the one white rectangle left on screen.

The views themselves are derived the same way rather than reimplemented: `planIssues` and
`planDays` live in `trip-clock.mjs` alongside the day-grouping helpers, so `get_plan_overview` and
the phone's Plan tab cannot report different numbers of issues for the same trip. That agreement is
asserted directly in `test/offline-companion.test.mjs`.

Sync status lives in the header and opens a sheet: last sync, pending writes, failed writes, the
"ask Claude" list.

One cheap win specific to this trip: a `metadata.address_local` convention on places, showing the
address in Chinese characters to hand to a taxi driver. Pure reference data, entirely offline, and
the kind of thing that justifies the app on its own.

**Add to Home Screen is load-bearing, not a nicety.** iOS evicts IndexedDB for sites unused for
seven days unless the app is installed. Onboarding has to insist on it.

## Sequencing

- **Phase 0 (server) — done.** `get_offline_snapshot` with coordinates, lessons, and trip state;
  `client_op_id` on the four append tools; `trip_offline_places` and the replay indexes in
  `202608110003_offline_snapshot.sql`; static route at `/app`. Registering the OAuth client is an
  operator step, in the root `README.md`.
- **Phase 1 (offline-read PWA) — done.** `ui/travel-companion`: OAuth via the MCP client SDK,
  snapshot into IndexedDB, Now / Plan / Places / Card, local search, staleness banner, service
  worker, install hint, erase-from-device, appearance override, maps (see below), and connected
  planning-task checkboxes.
- **Phase 2 (capture) — done.** `outbox-queue.mjs` holds the rules (what a queued write becomes on
  the wire, what it looks like before it lands, what happens when the trip moved underneath) and
  `outbox.ts` gives them an IndexedDB store keyed per operation and a replay that reuses one MCP
  connection for the whole run. The five safe writes are captured from one sheet plus Mark done and
  Skip on the timeline; the sync sheet in the header carries last sync, what is queued, what is
  failing, and the needs-attention list.
- **Phase 3.** "Ask Claude" handoff, photos into Supabase Storage, pending-proposal display.

### What the capture layer does and does not do

Every queued write shows immediately, carrying a `pending:` id so a view can tell what Travel Brain
has from what this phone is still holding — a note that vanished until the signal returned would
read as a note that was lost. Replay runs after a sync rather than before one, because the fresh
snapshot is what the conflict rules are checked against: an item deleted while the phone was dark is
an item missing from that snapshot, which is how its queued status update gets parked with its words
intact instead of being thrown five times at a server that will never accept it. Five rejections
retire an entry to needs-attention rather than retrying it forever, and only an explicit tap ever
discards one.

What is still Claude's: moving an item, adding a scheduled one, finding an alternative, research,
approving a proposal, and saying where the traveller is now. Planning-task checkboxes remain the one
connected-only write — they are deterministic, so there is nothing to queue and nothing to reconcile.

Two things are worth knowing before the trip. The shell is ~160 KB gzipped, most of it the MCP
client SDK, fetched once and then precached — fine on arrival wifi, slow on a bad hotel connection.
And the app derives nearby distances from the device GPS only when the traveller taps **Locate**;
it does not track position or write location back, so the server's last-known location is
only ever as fresh as Claude last made it.

## Maps

The coordinates are already on the phone — `trip_offline_places` decomposes the PostGIS point, so
every saved place arrives with a latitude and longitude. Not drawing them was leaving the traveller
to read a sorted list of metres while standing on a corner. There are three maps: today's stops in
timeline order on **Now**, a map/list toggle on **Places** over whatever the filters have already
narrowed to, and a mini-map on each lodging address on **Card**.

Two rules make this compatible with an app that has to work with the radio off.

**Offline draws a schematic, not a basemap.** `OfflineMap` is hand-drawn SVG with no dependency,
shipped in the shell: true relative positions, the traveller's own position, and a scale bar
measured with the same `haversineMeters` the nearby list uses. One place plus a known position
becomes a bearing dial — *that way, 1.6 km*. It is what renders when there is no connection, while
the map chunk loads, and if tiles fail. What is never rendered is a grid of grey squares.

**The library is not in the shell.** MapLibre is roughly as large again as the whole rest of the
app, so `MapPanel` reaches it through a dynamic `import()` and it lands in its own chunk — 249 KB
gzipped that a traveller on bad hotel wifi never fetches. Tiles need a working connection anyway, so
the code arrives at the same moment the tiles do. A test in `test/companion-app.test.mjs` asserts
the split in both directions.

Tiles come from OpenFreeMap: no API key, no account, no request cap, commercial use allowed, and
its Liberty style already labels in `name:latin` *and* `name:nonlatin`, so Chinese place names
appear beside the Latin ones — `address_local`'s reasoning, applied to the map. Attribution is left
on because rendering it is the licence condition. Because a tile request tells a third party which
corner of which city is on screen, the first map asks before loading one and remembers the answer in
`maps:enabled`; the Card tab can turn it back off, and `forgetDevice` clears it with everything
else.

**The zoom stops near where the data does.** That planet tileset declares `maxzoom: 14`, so past
z14 MapLibre rescales the z14 tile rather than fetching a finer one. Left at MapLibre's default
ceiling of z22 the pinch went on offering detail that could never arrive. It is worst over mainland
China, where OSM carries roads and points of interest but almost no building footprints — a z14
tile of central Guilin holds four buildings against Hong Kong's 176 — so the extra zoom only
magnified empty background, and a map that was merely sparse read as a map that was broken.
`MAX_ZOOM` caps it two steps above the source, which still pulls a cluster of pins apart.

**What counts as failure is decided by what failed, not by the error text.** `classifyMapError`
separates a dead style or source descriptor (fatal: nothing will ever render) from a single missing
tile (survivable) from a glyph or sprite (ignored: labels degrade, the map works). The rule it
replaced asked whether the error message contained the word "style", which matched only because the
style URL contains `/styles/`; tiles are served from `/planet/` and so never matched, and a blocked
or captive-portalled basemap left an empty rectangle instead of the schematic. `createTileWatch`
adds the asymmetry that matters: a map that has already painted keeps its place when one tile goes
missing, while a map that has never painted gives way after `TILE_FAILURE_LIMIT`.

Errors alone are not enough, though, because the worst failure is silent. MapLibre fetches and
parses vector tiles inside a web worker; a worker that never starts issues no requests and raises
no `error`, so nothing is left to classify. The map goes on painting what the main thread already
had — the style's background, and Liberty's Natural Earth raster backdrop — while the data that
matters never arrives, which looks like a working map that has simply run out of detail.
`BASEMAP_TIMEOUT_MS` catches that whole class without diagnosing it: if nothing has drawn by the
deadline, the schematic takes over. For the same reason `drew()` is called only for the *vector*
source — counting the raster backdrop as success would grant immunity to exactly the failure being
watched for. All of it lives in
`map-source.mjs` — plain JavaScript, outside the MapLibre chunk, so
`test/companion-map-failure.test.mjs` can exercise the rules directly without a DOM.

Still not built: **offline tiles**. Nothing is cached — the service worker already passes
cross-origin requests straight through, so no change was needed to keep that true. A pre-downloaded
PMTiles archive for the trip's bounding box is the obvious next step if the schematic proves too
thin in Guilin, and the OpenFreeMap style URL swaps for a self-hosted archive without touching
anything else.

## Deliberately not building

Offline map tiles, and any model in the app. Multi-trip sync. Editing planned times offline. A
second MCP service, a frontend database, or any service credential in the browser — the same
boundaries `docs/architecture.md` already draws for the dashboard.

## The cheaper alternative, for the record

If the PWA does not make it before departure: have Claude generate a static, self-contained HTML
trip sheet — timeline, addresses, confirmation codes — and save it to the phone. No auth, no sync,
no capture, and it goes stale the moment anything changes. But it is an afternoon of work instead of
a project, it works anywhere, and it covers the panic cases. Worth keeping as the fallback even
after the PWA exists.
