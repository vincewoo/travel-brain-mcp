# Travel Brain MCP

Travel Brain is a database-authoritative MCP backend for travel planning, live concierge work, research, journaling, recommendations, and preference memory. The server exposes Streamable HTTP at `/mcp`; Supabase/PostgreSQL remains the canonical store.

The service supports two protected authentication modes:

- `static`: interim single-user local/staging mode. A high-entropy MCP bearer token protects service-role access acting as `TRAVEL_BRAIN_USER_ID`.
- `supabase_oauth`: production resource-server mode. Supabase Auth verifies each OAuth access token, the token subject becomes the actor, and a request-scoped Supabase client sends that user JWT so RLS applies.

`/health` is intentionally public and performs no database call. There is no unauthenticated MCP mode and no OpenAI API dependency.

## MCP surface

The original 12 tools remain available:

- `list_trips`
- `create_trip`
- `get_trip`
- `add_place`
- `add_itinerary_item`
- `update_itinerary_item`
- `save_research_finding`
- `record_journal_note`
- `mark_place_visited`
- `remember_preference`
- `recommend_place`
- `search_travel_brain`

Step 4 adds 11 concierge/read-model tools over the same canonical data:

- `get_today`
- `get_current_context`
- `update_current_trip_state`
- `get_nearby_saved_places`
- `get_plan_overview`
- `get_places_overview`
- `get_recent_journal`
- `get_recommendations`
- `get_trip_lessons`
- `propose_itinerary_change`
- `commit_itinerary_change`

Step 5 adds one visual launcher over those same tools:

- `show_travel_dashboard`

The launcher serves one embedded MCP App with Today, Plan, Places, Journal, and Recommendations views. Its `view` input is optional; when omitted, the dashboard selects Places for draft trips, Plan for planning trips, Today for active trips, Journal for completed trips, and Recommendations for archived trips.

See `docs/mcp-tools.md` for contracts and `examples/vertical-slice.md` for the existing research → plan → visit → journal → recommend → learn scenario.

## Prerequisites

- Node.js 20 or newer
- A Supabase project with the migrations in `supabase/migrations/` applied
- Docker for container verification
- Fly CLI plus a Fly account for deployment

Apply migrations with a linked Supabase CLI:

```bash
supabase db push
```

Alternatively, run the migration files in filename order in the Supabase SQL editor. Create at least one Supabase Auth user before using static mode; its UUID is `TRAVEL_BRAIN_USER_ID`.

## Local development (protected static mode)

```bash
cd mcp-server
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `MCP_BEARER_TOKEN` and fill in:

```dotenv
NODE_ENV=development
MCP_AUTH_MODE=static
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
TRAVEL_BRAIN_USER_ID=YOUR_AUTH_USER_UUID
MCP_BEARER_TOKEN=YOUR_GENERATED_TOKEN
HOST=127.0.0.1
PORT=3000
LOCATION_FRESHNESS_MINUTES=30
ALLOWED_HOSTS=
ALLOWED_ORIGINS=
```

Install reproducibly, check, and run:

```bash
npm --prefix ui/travel-dashboard ci
npm --prefix ui/travel-dashboard run build
npm ci
npm run check
npm run dev
```

In another terminal:

```bash
curl --fail http://127.0.0.1:3000/health

export MCP_BEARER_TOKEN='the-same-token-from-.env'
npx -y @modelcontextprotocol/inspector@2.1.0 --cli \
  http://127.0.0.1:3000/mcp \
  --transport http \
  --method tools/list \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}" \
  --format json
```

Negative auth checks:

```bash
curl -i http://127.0.0.1:3000/mcp
curl -i -H 'Authorization: Bearer invalid' http://127.0.0.1:3000/mcp
```

Both MCP requests must return `401`; health must remain `200`.

## Automated verification

```bash
cd mcp-server
npm run check
cd ui/travel-dashboard
npm run build
```

This runs syntax checks plus regression tests for configuration, token/identity mapping, application-level owner/editor/viewer authorization, request-scoped OAuth clients, the 23 data tools plus the unified dashboard launcher/resource, timezone-correct read models, location freshness/privacy, provenance, proposal non-mutation, atomic commit delegation, and the single-file dashboard build.

The repository also contains a real PostgreSQL fixture at `mcp-server/test/sql/step4-integration.sql`. Run it after applying migrations to an isolated Supabase Postgres database; it verifies PostGIS ordering plus proposal commit, stale rejection, atomicity, idempotency, viewer denial, and planned-vs-actual preservation.

The HTTP integration test opens a loopback port and is opt-in for restricted CI/sandbox environments:

```bash
TRAVEL_BRAIN_NETWORK_TESTS=1 npm test
```

## Local container verification

The image installs from `package-lock.json`, contains runtime dependencies only, and runs as the non-root `node` user. A minimal bootstrap listener binds the configured port immediately during cold start: `/health` reports `status: starting`, all other paths return `503`, and traffic is handed to the fully protected application after its dependencies load.

```bash
cd mcp-server
docker build --tag travel-brain-mcp:0.1.0 .

docker run --rm --name travel-brain-mcp \
  --publish 8080:8080 \
  --env-file .env \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=8080 \
  --env ALLOWED_HOSTS=localhost,127.0.0.1 \
  travel-brain-mcp:0.1.0
```

Then repeat the health, unauthenticated, and Inspector checks above against `http://127.0.0.1:8080`.

## Fly.io staging deployment

Static mode is safe for a private single-user staging deployment only. It protects the fixed-user/service-role path with a separate high-entropy bearer token.

The checked-in `mcp-server/fly.toml` now targets `travel-brain-mcp` in `supabase_oauth` mode. To reproduce the interim static staging procedure below in another app, explicitly change `MCP_AUTH_MODE` back to `static` and remove `PUBLIC_BASE_URL` before deploying. Do not deploy static-mode service-role credentials to an OAuth-configured app by assumption.

1. Choose a unique app name and edit both placeholder values in `mcp-server/fly.toml`:
   - `app`
   - `ALLOWED_HOSTS` (`<app>.fly.dev`)
2. Optionally change `primary_region` from `sjc`.
3. Create the app, set secrets, deploy, and inspect health:

```bash
cd mcp-server
export FLY_APP='your-unique-travel-brain-name'

fly apps create "${FLY_APP}"
fly secrets set --app "${FLY_APP}" \
  SUPABASE_URL='https://YOUR_PROJECT.supabase.co' \
  SUPABASE_PUBLISHABLE_KEY='sb_publishable_YOUR_KEY' \
  SUPABASE_SERVICE_ROLE_KEY='YOUR_SERVICE_ROLE_KEY' \
  TRAVEL_BRAIN_USER_ID='YOUR_AUTH_USER_UUID' \
  MCP_BEARER_TOKEN='YOUR_HIGH_ENTROPY_TOKEN'

fly deploy --app "${FLY_APP}"
fly status --app "${FLY_APP}"
fly checks list --app "${FLY_APP}"
fly logs --app "${FLY_APP}"
curl --fail "https://${FLY_APP}.fly.dev/health"
```

Do not put service keys or bearer tokens in `fly.toml`.

Verify remote discovery and persistence:

```bash
export MCP_URL="https://${FLY_APP}.fly.dev/mcp"

npx -y @modelcontextprotocol/inspector@2.1.0 --cli \
  "${MCP_URL}" --transport http --method tools/list \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}" --format json

npx -y @modelcontextprotocol/inspector@2.1.0 --cli \
  "${MCP_URL}" --transport http --method tools/call \
  --tool-name list_trips \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}" --format json

npx -y @modelcontextprotocol/inspector@2.1.0 --cli \
  "${MCP_URL}" --transport http --method tools/call \
  --tool-name create_trip \
  --tool-arg title='Fly staging verification' \
  --tool-arg destination_summary='Fly.io' \
  --tool-arg timezone='UTC' \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}" --format json

npx -y @modelcontextprotocol/inspector@2.1.0 --cli \
  "${MCP_URL}" --transport http --method tools/call \
  --tool-name list_trips \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}" --format json
```

The final result must include the newly created trip. Then run `examples/vertical-slice.md` rather than inventing a parallel scenario.

Fly defaults to zero always-running Machines. For lower concierge latency, change:

```toml
auto_stop_machines = "off"
min_machines_running = 1
```

This trades ongoing compute cost for avoiding cold starts.

The checked-in Fly health check sends `Host: travel-brain-mcp.fly.dev`. This keeps strict Host validation enabled while allowing Fly's internal probe to reach `/health`; do not replace it with a wildcard or disable Host validation.

## Production Supabase OAuth 2.1 mode

The code side of the MCP resource server is implemented:

- RFC 9728 protected-resource metadata is served at `/.well-known/oauth-protected-resource/mcp`.
- Supabase authorization-server metadata is mirrored at the MCP origin for legacy discovery.
- The MCP SDK bearer middleware verifies each token through Supabase `getClaims()`.
- OAuth tokens must contain the expected Supabase issuer, an authenticated role, expiration, subject, and OAuth `client_id`.
- The verified `sub` becomes `actorId`; no `TRAVEL_BRAIN_USER_ID` is read in this mode.
- Each tool invocation gets a fresh Supabase client using the publishable key and caller token, so `auth.uid()` and existing RLS policies apply.
- A caller-scoped profile upsert bootstraps `profiles` through the existing self-insert RLS policy.
- `/oauth/consent` provides a no-store, clickjacking-protected consent screen with Google, password, and magic-link sign-in. It shows the registered client, redirect URI, and requested scopes before allowing approval or denial.

Google is the recommended human sign-in method. A traveler signs in with their Google account; Supabase creates or reuses the corresponding Auth user record automatically. The traveler does not create separate Supabase credentials, and Travel Brain requests only basic sign-in identity—not Gmail, Calendar, or Drive access.

### Required dashboard configuration

The public Fly origin is HTTPS. Port `3000` is only the local development default, so do not use `http://travel-brain-mcp.fly.dev:3000` in production settings.

1. In Supabase Dashboard → Authentication → URL Configuration:
   - set **Site URL** to `https://travel-brain-mcp.fly.dev`
   - add the exact **Redirect URL** `https://travel-brain-mcp.fly.dev/oauth/consent`
2. In Supabase Dashboard → Authentication → OAuth Server:
   - enable the OAuth 2.1 server
   - set **Authorization Path** to `/oauth/consent`
   - verify the preview is `https://travel-brain-mcp.fly.dev/oauth/consent`
3. In Google Auth Platform, create a **Web application** OAuth client:
   - authorized JavaScript origin: `https://travel-brain-mcp.fly.dev`
   - authorized redirect URI: the Supabase callback shown on its Google provider page, normally `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
   - configure the audience as External for general Google-account access; while the Google app is in testing, add each intended user as a test user
   - request only `openid`, email, and profile scopes
4. In Supabase Dashboard → Authentication → Sign In / Providers → Google, enable Google and enter that Google client ID and client secret.
5. Decide whether to enable dynamic MCP client registration. If enabled, require explicit user approval and review registered clients; otherwise pre-register each MCP client and its exact redirect URI.
6. Confirm Google sign-in, approval, denial, and existing RLS policies with real users. Optionally add `client_id`-specific restrictive policies if only approved OAuth clients should access Travel Brain.

The Google client secret belongs only in the Supabase dashboard. The browser consent page receives only `SUPABASE_PUBLISHABLE_KEY`; it rejects service-role/secret keys. The `authorization_id` is preserved in same-tab session storage across Google and magic-link redirects, then removed before returning to the MCP client.

Self-registering MCP clients require Supabase discovery metadata to contain `registration_endpoint`. Verify it after enabling Dynamic Client Registration; if it is absent, use a manually registered OAuth client instead.

You can deploy and preview `/oauth/consent` while Fly remains in protected static mode, but Google-issued user tokens cannot authenticate `/mcp` until the deployed resource server is switched to `supabase_oauth`.

Switch the deployed resource server after those steps:

```bash
export FLY_APP='your-unique-travel-brain-name'
export PUBLIC_BASE_URL="https://${FLY_APP}.fly.dev"

fly secrets set --app "${FLY_APP}" \
  SUPABASE_URL='https://YOUR_PROJECT.supabase.co' \
  SUPABASE_PUBLISHABLE_KEY='sb_publishable_YOUR_KEY' \
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL}" \
  MCP_AUTH_MODE='supabase_oauth'

fly secrets unset --app "${FLY_APP}" \
  SUPABASE_SERVICE_ROLE_KEY TRAVEL_BRAIN_USER_ID MCP_BEARER_TOKEN

fly deploy --app "${FLY_APP}"
curl --fail "${PUBLIC_BASE_URL}/health"
curl --fail "${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"
curl -i "${PUBLIC_BASE_URL}/mcp"
```

The last request must be `401` and its `WWW-Authenticate` header must advertise the protected-resource metadata URL. Complete the OAuth login in an MCP client/Inspector, list all 24 tools (23 data tools plus `show_travel_dashboard`), and run owner/editor/viewer/unrelated-user and write-persistence checks with real users.

## Automatic Fly.io deployment

The GitHub Actions workflow in `.github/workflows/deploy-fly.yml` validates every relevant MCP server or dashboard pull request with the full test suite, dashboard build, and production Docker build. A successful relevant push to `main` (or a manual workflow dispatch) deploys the server with its embedded MCP App to the existing `travel-brain-mcp` Fly app, then verifies health, OAuth resource discovery, and the anonymous `401` boundary on `/mcp`.

Create an app-scoped Fly deploy token and save it as the repository Actions secret `FLY_API_TOKEN`:

```bash
fly tokens create deploy \
  --app travel-brain-mcp \
  --name github-actions \
  --expiry 8760h
```

Copy the command output into GitHub repository **Settings → Secrets and variables → Actions → New repository secret**. This token can deploy only this Fly app and expires after one year. Supabase keys remain Fly secrets and must not be copied into GitHub.

For an approval gate, create or edit the GitHub `production` environment under **Settings → Environments** and add the desired required reviewers. The workflow works without an approval rule, but still records deployments against that environment.

## Security and product invariants

- Service-role access exists only in bearer-protected static mode.
- OAuth mode never uses a module-global actor or shared mutable Supabase auth state.
- Application-level trip membership checks remain as defense in depth; OAuth mode also relies on RLS.
- A `firsthand` recommendation still requires a recorded visit.
- Actual visit timing never overwrites planned timing.
- `raw_note` is written separately and never replaced with generated prose.
- Semantic memory and sourced research remain separate tables and tool paths.
- Embeddings remain optional and no OpenAI dependency is present.
- No continuous GPS history was introduced.

See `docs/security.md` for the mode-by-mode threat model and operator checklist.

## Primary references

- [MCP TypeScript SDK authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
- [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase OAuth Server setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token security and RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Fly app configuration](https://fly.io/docs/reference/configuration/)
