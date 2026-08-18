# Security model

Travel Brain has no anonymous MCP mode. `/health` is public and lightweight; every method on `/mcp` requires a verified bearer credential.

## Authentication modes

| Environment | `MCP_AUTH_MODE` | MCP credential | Supabase credential used for tool queries | Identity/RLS behavior |
|---|---|---|---|---|
| Local development | `static` | High-entropy `MCP_BEARER_TOKEN` | Service-role key | Fixed `TRAVEL_BRAIN_USER_ID`; application checks are the authorization boundary |
| Remote staging | `static` | High-entropy `MCP_BEARER_TOKEN` | Service-role key stored as a Fly secret | Same fixed actor; HTTPS plus bearer auth is mandatory |
| Production | `supabase_oauth` | Supabase OAuth 2.1 user access token | Publishable key plus that user token | Verified token `sub`; Postgres RLS and application checks both apply |

Static mode is an interim single-user mechanism. Because the service-role credential bypasses RLS, it must never be exposed through an anonymous endpoint. Startup requires a bearer token of at least 32 bytes and rejects a publishable key supplied as `SUPABASE_SERVICE_ROLE_KEY`.

OAuth mode does not accept `TRAVEL_BRAIN_USER_ID` as identity. Supabase validates the JWT; the server requires the expected issuer, `authenticated` role, expiration, `sub`, and OAuth `client_id`. The verified subject is injected into database functions through a request-scoped context. A new Supabase client is created with the publishable key and caller's Authorization header; a shared singleton's session or headers are never mutated.

## OAuth discovery and resource-server boundary

In `supabase_oauth` mode the MCP service acts only as a resource server. Supabase Auth remains the OAuth authorization server.

The service publishes:

- `/.well-known/oauth-protected-resource/mcp` for RFC 9728 resource metadata
- `/.well-known/oauth-authorization-server` as a compatibility mirror of Supabase authorization-server metadata
- `WWW-Authenticate: Bearer` challenges pointing clients at protected-resource metadata

The service does not issue access/refresh tokens and does not contain a home-grown authorization server.

`/oauth/consent` is the user-facing approval UI required by Supabase OAuth Server. It uses the public Supabase browser key to authenticate travelers and invoke Supabase's authorization-details, approve, and deny APIs. Supabase still validates the authorization request and issues every code/token. The page is served with `Cache-Control: no-store`, a restrictive Content Security Policy, clickjacking protection, no referrer, and no access to the service-role key.

Google social login is an identity input to Supabase Auth, not a second MCP token issuer. On first Google sign-in Supabase creates an Auth user record automatically; users do not manage separate Supabase credentials. Only basic identity scopes are required. The Google provider secret is held by Supabase and is never configured on Fly or sent to the consent page.

## Database authorization

All public application tables have RLS enabled. Existing policies use `auth.uid()` plus trip ownership/membership. OAuth access tokens include the user subject and OAuth `client_id`, so existing user policies continue to work and can later be narrowed by approved `client_id`.

Application-level `tripAccess()` checks remain in both modes:

- owner: read/write
- editor: read/write shared trip
- viewer: read-only shared trip
- unrelated user: no access

In static mode these checks are essential because the service role bypasses RLS. In OAuth mode they are defense in depth and RLS may hide inaccessible rows before the application sees them.

Itinerary proposals add a second write boundary. Members may read proposal records, but only owners/editors may insert them. Proposal rows cannot be directly updated or deleted through RLS. The `commit_itinerary_change_proposal` security-definer RPC verifies that `p_actor_id` matches `auth.uid()` whenever a user JWT is present, checks owner/editor access itself, locks proposal and itinerary rows, validates a strict operation whitelist, checks `updated_at` versions, and applies the complete change in one transaction. Static mode passes its already-verified fixed actor to the same RPC.

Profile bootstrap is request-scoped. Before the first tool operation in an authenticated HTTP request, the server upserts only the verified actor's `profiles` row. In OAuth mode the existing self-insert/self-update profile policy authorizes that operation; no service role is used.

## Companion PWA

The companion is served as static files at `/app` on the MCP origin and is deliberately public: it contains no trip data, no keys, and no service credential. It authenticates as its own OAuth 2.1 client through the same Supabase authorization server, either pre-registered (`VITE_OAUTH_CLIENT_ID`) or dynamically registered, with the exact redirect URI `<PUBLIC_BASE_URL>/app/callback`. The MCP transport remains the only authorization boundary; the browser holds a user token and nothing more.

Two exposures are inherent to an offline app and are accepted deliberately rather than mitigated with theatre:

- **A refresh token is persisted on the device**, in IndexedDB. Without it the app could not re-sync after the access token expires, which is most of the time on a trip.
- **The whole trip, including the traveller's own private journal entries, is cached in plaintext on the phone.** Encrypting it would require a passphrase on every open, which defeats a reference you read while walking. Device lock is the control that actually applies.

Captured writes waiting for a signal sit in the same store, which means an unsent journal note is on the device in plaintext exactly as a synced one is. The compensating control is explicit and in the UI: **Sign out and erase from this device** clears IndexedDB — the cached trip and the outbox together, so a forgotten device does not go on speaking for the traveller later — plus session storage and every cache entry. Same-origin hosting keeps the cache and the token inside one origin's storage.

The service worker caches only this app's own same-origin `GET` requests. It never caches `/mcp`: a replayed tool response would present a stale itinerary as live, which no cache header could make honest.

### Basemap tiles

Maps are the one feature that reaches an origin other than this server or Supabase. Tiles come from OpenFreeMap (`https://tiles.openfreemap.org`), with no API key and therefore no account identifying the traveller — but the requests themselves disclose which map tiles are being fetched, which is to say which corner of which city is on screen, and by extension roughly where the traveller is and which places they saved. In an app that deliberately keeps no GPS trail, that is worth naming rather than burying.

Three things bound it. Tiles are **opted into once** and never loaded before that: the answer is stored as `maps:enabled` in IndexedDB, revocable on the Card tab, and cleared by **Sign out and erase from this device** with everything else. Nothing is sent to OpenFreeMap except tile coordinates — no trip data, no token, no place names, no query. And with tiles off or the device offline, maps still draw from coordinates already on the phone, so declining costs the basemap and nothing else.

Tiles are never cached: the service worker's cross-origin passthrough already ensures this, which is also what keeps the "no offline tiles" boundary in `docs/companion-pwa.md` true.

`/app` ships no `Content-Security-Policy` today. When one is added — `docs/companion-pwa.md` intends a strict one, and `src/oauth-consent.mjs` is the model — maps require `connect-src https://tiles.openfreemap.org` (style and vector tiles are fetched with `fetch`, not as images) plus `worker-src blob:` and `script-src blob:`, because MapLibre creates its tile-decoding worker from a blob URL. A policy written without these will break maps silently, in the field, offline-looking rather than blocked-looking.

## Secret handling

Never commit or bake these values into an image:

- `SUPABASE_SERVICE_ROLE_KEY`
- `MCP_BEARER_TOKEN`
- OAuth access or refresh tokens
- Google OAuth client secrets

Use a local ignored `.env` for development and Fly secrets for deployment. The server logs request IDs, method/path, status/duration, tool name, and high-level errors. It does not log Authorization headers, tokens, service keys, tool inputs, journal text, or full database records.

## Host and Origin validation

`ALLOWED_HOSTS` and `ALLOWED_ORIGINS` are comma-separated hostnames without scheme, path, or port. Empty arrays are omitted from `createMcpExpressApp`; they are never passed explicitly as `[]`.

For Fly, set `ALLOWED_HOSTS=<app>.fly.dev` plus any custom domains. Add Origin hostnames only for browser-hosted clients that send an Origin header. If a Fly health check reports `403`, inspect the actual Host header and add that specific hostname rather than disabling validation broadly.

## Product-data protections

- Firsthand recommendations require a recorded visit.
- Planned and actual itinerary timestamps are distinct.
- Raw traveler notes stay in `raw_note`; generated prose has a separate field.
- Semantic preferences keep provenance, confidence, and confirmation status.
- Research stays atomic and sourced with freshness/volatility metadata.
- `current_trip_state.last_location` is overwritten in its one-per-trip row and is always returned with fresh/stale/missing qualification; no continuous GPS trail is stored.
- Reasoning-derived itinerary repairs are stored as non-authoritative proposals and committed only through an atomic, idempotent RPC after approval.

## Operator-only production prerequisites

Repository code cannot complete these account/dashboard actions:

1. Enable Supabase OAuth 2.1 Server.
2. Set the Supabase Site URL to the public HTTPS Fly origin and Authorization Path to `/oauth/consent`.
3. Configure Google Auth Platform and enable the Google provider in Supabase.
4. Enable dynamic registration or pre-register clients and exact redirect URIs.
5. Review/approve clients and ensure users can authenticate.
6. Exercise RLS with real OAuth tokens and multiple users.
7. Create the Fly app, set secrets, deploy, and validate the public endpoint.

Exact commands are in the root README.
