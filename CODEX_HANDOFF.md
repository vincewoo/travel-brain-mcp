# Codex Engineering Handoff — Travel Brain v0.1 → Fly.io Remote MCP

**Date:** 2026-08-10  
**Audience:** Codex / implementation agent  
**Repository:** `travel-brain`  
**Primary package:** `mcp-server/`  
**Backend:** Supabase (PostgreSQL + RLS + pgvector + PostGIS)  
**Current MCP transport:** Streamable HTTP at `/mcp`

---

## 0. Codex directive

Continue the existing Travel Brain project; do **not** redesign it from scratch.

The immediate objective is to productionize the working local MCP server so it can run as a remote service on Fly.io without exposing the current service-role/fixed-user development model directly to the public internet.

Work in incremental milestones, preserve existing behavior, and leave the repository in a state where another engineer can reproduce deployment from the README.

### Highest-priority deliverables

1. Containerize the existing `mcp-server`.
2. Add safe configuration validation and production defaults.
3. Deploy or make the repo deployment-ready for Fly.io.
4. Protect the remote MCP endpoint.
5. Preserve all 12 current MCP tools and their semantics.
6. Provide automated/local verification plus remote verification commands.
7. Prepare the codebase for Supabase OAuth 2.1 / per-user RLS as the production authentication model.
8. Do **not** add an OpenAI API dependency for this milestone.

If Fly credentials are available in the environment, perform the deployment and validate the public endpoint. If credentials or dashboard-only configuration are unavailable, complete all repository changes and give exact remaining operator steps.

---

# 1. Product context

Travel Brain is the shared backend for an agentic:

- travel planner,
- live travel concierge,
- travel journal,
- research memory,
- semantic preference memory,
- and reusable friend-recommendation system.

The intended long-term architecture is:

```text
                Supabase / Travel Brain
                       ▲
                       │
              Travel Brain backend
                 / MCP service
                       ▲
             ┌─────────┴─────────┐
             │                   │
          ChatGPT          Companion App
          planning          live trip mode
          research          Now / Next
          journaling        location context
          replanning        quick notes
```

The **database is authoritative**. Chat history is never the canonical itinerary, visit history, research record, journal, or preference store.

---

# 2. Current project status

The existing project is already functional locally.

## Confirmed working

- Supabase migrations have been applied.
- A Supabase Auth user exists.
- The MCP server starts successfully on the developer machine.
- Supabase service-role configuration was corrected after an initial RLS error.
- Local endpoint:
  - `http://127.0.0.1:3000/mcp`
- Health endpoint:
  - `http://127.0.0.1:3000/health`
- MCP Inspector CLI successfully connected and returned `tools/list`.
- The MCP protocol/transport itself is therefore known-good locally.

The developer is using Node.js `v26.7.0` locally. The project requires Node.js 20+.

## Existing MCP tools

These 12 tools are currently exposed and should remain available:

1. `list_trips`
2. `create_trip`
3. `get_trip`
4. `add_place`
5. `add_itinerary_item`
6. `update_itinerary_item`
7. `save_research_finding`
8. `record_journal_note`
9. `mark_place_visited`
10. `remember_preference`
11. `recommend_place`
12. `search_travel_brain`

Do not rename these unless there is a compelling compatibility reason.

---

# 3. Existing repository layout

Current v0.1 layout:

```text
travel-brain/
├── README.md
├── .gitignore
├── agent/
│   └── TRAVEL_AGENT.md
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── memory-model.md
│   ├── mcp-tools.md
│   └── security.md
├── examples/
│   └── vertical-slice.md
├── mcp-server/
│   ├── .env.example
│   ├── package.json
│   └── src/
│       ├── db.mjs
│       ├── server.mjs
│       └── tools.mjs
└── supabase/
    ├── migrations/
    │   ├── 202608100001_extensions.sql
    │   ├── 202608100002_schema.sql
    │   ├── 202608100003_rls.sql
    │   └── 202608100004_storage.sql
    └── seed.example.sql
```

---

# 4. Architectural invariants — preserve these

These are product requirements, not implementation suggestions.

## 4.1 Structured state vs. memory

Three memory layers must remain distinct:

### Structured state — authoritative
Examples:

- trips,
- itinerary,
- reservations,
- actual visits,
- planned and actual timestamps.

### Semantic memory
Examples:

- explicit traveler preferences,
- constraints,
- learned tendencies,
- lessons from previous trips.

Semantic memory must retain:

- provenance,
- confidence,
- confirmation status.

An inferred preference normally begins as a `candidate`; an explicit user preference can be `confirmed`.

### Research memory
Research is stored as atomic findings with:

- sources,
- freshness / `valid_as_of`,
- volatility,
- confidence,
- trip/place relevance.

The research store must not collapse into unsourced model prose.

---

## 4.2 Planned vs. actual

Never overwrite historical reality when replanning.

Itinerary records distinguish:

```text
planned_start
planned_end

actual_start
actual_end
```

This is essential for both concierge behavior and later trip journaling.

---

## 4.3 Firsthand vs. researched recommendations

A recommendation has explicit provenance:

```text
firsthand
research
mixed
```

The existing MCP logic rejects a `firsthand` recommendation unless a recorded `place_visit` exists for that trip/place.

Preserve this invariant.

---

## 4.4 Journal integrity

A raw traveler note must remain separate from generated prose.

The journal should preserve what the traveler actually said. A future generated travel narrative may reference it but must not replace it.

---

## 4.5 Location privacy

The system may store a latest/current location as ephemeral trip state.

Do **not** introduce continuous historical GPS tracking as part of this milestone.

Journal entries or actual visits may retain a location when deliberately attached to the event.

---

## 4.6 Embeddings are optional in v0.1

The schema includes pgvector-ready embedding fields, but they are nullable.

Do **not** make this deployment depend on the OpenAI API or any embedding provider.

Current `search_travel_brain` is lexical. Hybrid/vector retrieval is a later milestone.

---

# 5. Current security model — IMPORTANT

The local-development server currently uses:

```text
SUPABASE_SERVICE_ROLE_KEY
TRAVEL_BRAIN_USER_ID
```

`db.mjs` creates one singleton privileged Supabase client, and `TRAVEL_BRAIN_USER_ID` is treated as the actor.

Because the Supabase service-role/secret credential bypasses RLS, application-level ownership/membership checks are performed by `tripAccess()`.

This is acceptable for a private local vertical slice.

**It must not become an unauthenticated public Fly.io service.**

---

# 6. Deployment target

Deploy the MCP service to Fly.io.

Target shape:

```text
ChatGPT / Codex / MCP client
             │
             │ HTTPS
             ▼
https://<fly-app>.fly.dev/mcp
             │
             ▼
       Fly.io Machine
             │
             ▼
         Supabase
```

The app must bind to all interfaces inside Fly:

```text
HOST=0.0.0.0
PORT=8080
```

Fly should terminate public TLS and route to internal port `8080`.

Keep `/health` unauthenticated and lightweight so Fly health checks can use it.

---

# 7. Implementation plan

## Milestone A — establish a reproducible baseline

Before changing behavior:

1. Run:
   ```bash
   cd mcp-server
   npm install
   npm run check
   npm run dev
   ```

2. Confirm:
   ```bash
   curl http://127.0.0.1:3000/health
   ```

3. Confirm MCP discovery:
   ```bash
   npx @modelcontextprotocol/inspector@latest --cli \
     --server-url http://127.0.0.1:3000/mcp \
     --transport http \
     --method tools/list \
     --format json
   ```

4. If the repository does not yet contain a lockfile, generate and commit `package-lock.json`.

5. Avoid `"latest"` dependencies in the final deployable state. Pin the versions actually tested by this change.

6. Add automated tests where practical instead of relying only on manual Inspector calls.

---

# 8. Configuration hardening

Create a dedicated configuration module rather than reading environment variables ad hoc from `db.mjs` and `server.mjs`.

Suggested file:

```text
mcp-server/src/config.mjs
```

At minimum validate:

```text
SUPABASE_URL

# Current staging model:
SUPABASE_SERVICE_ROLE_KEY
TRAVEL_BRAIN_USER_ID
MCP_BEARER_TOKEN

# Production OAuth model:
SUPABASE_PUBLISHABLE_KEY
PUBLIC_BASE_URL

HOST
PORT
ALLOWED_HOSTS
NODE_ENV
```

Not every variable must be required in every mode; validate according to the selected auth mode.

Recommended explicit mode variable:

```text
MCP_AUTH_MODE=static|supabase_oauth
```

### Required validation behavior

Fail fast with useful messages.

Examples:

- If `SUPABASE_SERVICE_ROLE_KEY` starts with `sb_publishable_`, refuse startup.
- Do not log secret values.
- In production, refuse to start with no MCP authentication.
- If `HOST=0.0.0.0` and `ALLOWED_HOSTS` is configured, pass it to `createMcpExpressApp`.
- `ALLOWED_HOSTS` values are hostnames, not full URLs.

Add/update `.env.example` with descriptions but no real secrets.

---

# 9. Stage 1 remote security: static bearer token

Implement a **safe staging deployment** first so the Fly endpoint can be tested remotely without exposing the existing fixed-actor service-role model anonymously.

This is an interim single-user mechanism, not the final multi-user model.

## Desired behavior

Requests to:

```text
/mcp
```

must require:

```http
Authorization: Bearer <high-entropy-token>
```

Requests to:

```text
/health
```

remain unauthenticated.

Keep:

```text
TRAVEL_BRAIN_USER_ID
SUPABASE_SERVICE_ROLE_KEY
```

for this staging mode, but only behind bearer authentication.

Use constant-time token comparison where feasible and return `401` for absent/invalid credentials.

Prefer the current MCP SDK's authentication primitives where they fit; otherwise a narrowly scoped Express middleware is acceptable for this staging step.

### Why this stage exists

It enables:

- Fly deployment,
- remote MCP Inspector testing,
- remote Codex testing,
- validation of host/proxy behavior,

without waiting for the complete OAuth UX.

It is **not** sufficient as the final ChatGPT multi-user authentication design.

---

# 10. Production authentication target: Supabase OAuth 2.1

Prepare and, where possible, implement the proper production model using **Supabase Auth as an OAuth 2.1 authorization server**.

Supabase currently documents MCP authentication as a supported OAuth 2.1 use case, including:

- PKCE,
- discovery,
- dynamic client registration,
- Supabase JWT access tokens,
- and normal RLS enforcement.

The MCP server should act as an **OAuth resource server**, not as the token issuer.

## Desired request flow

```text
MCP client
   │
   │ OAuth
   ▼
Supabase Auth
   │
   │ user access token
   ▼
Fly.io MCP resource server
   │
   │ user-scoped Supabase requests
   ▼
Postgres RLS
```

## MCP SDK integration direction

Use the current Model Context Protocol TypeScript SDK resource-server support, especially concepts equivalent to:

```text
requireBearerAuth
mcpAuthMetadataRouter
getOAuthProtectedResourceMetadataUrl
```

The MCP server must:

1. Advertise protected-resource metadata.
2. Validate Supabase-issued access tokens.
3. Map the authenticated subject to the Travel Brain actor.
4. Pass authentication context through to tool handlers.
5. Make user-scoped Supabase database calls so RLS enforces row ownership/membership.

Current MCP SDK v2 passes verified HTTP authentication to tool handlers through handler context (`ctx.http.authInfo`).

Do not create a new home-grown OAuth authorization server inside the MCP package if Supabase Auth can perform that role.

---

# 11. Refactor database access for request-scoped identity

The biggest internal change for proper OAuth is removing the current module-level global actor:

```js
const ACTOR_ID = process.env.TRAVEL_BRAIN_USER_ID;
export const actorId = ACTOR_ID;
export const supabase = createClient(...service role...);
```

Move toward request-scoped dependency injection.

Suggested conceptual API:

```js
{
  actorId,
  supabase,
  authInfo
}
```

Pass this context into database functions:

```js
listTrips(ctx)
createTrip(ctx, input)
getTrip(ctx, tripId)
addPlace(ctx, input)
...
```

Tool callbacks should resolve request authentication from MCP handler context and call database functions with the corresponding request context.

Example conceptual direction only:

```js
server.registerTool(..., async (input, ctx) => {
  const requestContext = buildRequestContext(ctx);
  return textResult({
    trip: await createTrip(requestContext, input)
  });
});
```

Use the actual callback signature/types provided by the installed MCP SDK version.

---

# 12. User-scoped Supabase access and RLS

For OAuth mode, the normal tool request path should no longer execute all database operations through a service-role client.

Create a Supabase client that uses:

- the project publishable key,
- the authenticated user's Supabase access token.

That lets the existing RLS policies operate with the user's JWT identity.

The exact `supabase-js` configuration should follow the current supported server-side token pattern; do not manually mutate a shared singleton's auth header between simultaneous requests.

### Service-role policy

The service-role/secret credential should be:

- removed from ordinary user request paths where feasible,
- kept only for narrowly defined administrative/bootstrap tasks if genuinely necessary,
- never sent to a client,
- never logged.

Preserve application-level membership/invariant checks as defense in depth even when RLS is active.

---

# 13. Profile bootstrap in OAuth mode

The current server calls:

```text
ensureProfile()
```

at application startup because the actor is globally known.

That will no longer be valid when identity is per request.

Refactor this behavior.

Reasonable options:

1. Upsert the profile after the caller is authenticated and before the first tool operation.
2. Add a database trigger for new `auth.users` if that better matches the existing schema.
3. Use another clean server-side initialization pattern.

Prefer the smallest change that preserves RLS and does not require a service-role request for every MCP invocation.

---

# 14. Fly.io files

Add at least:

```text
mcp-server/Dockerfile
mcp-server/.dockerignore
mcp-server/fly.toml
```

If repo-root deployment is more ergonomic, adjust paths accordingly, but document the exact command.

## Docker requirements

- Use a supported Node.js runtime compatible with the project.
- Install from lockfile with `npm ci`.
- Use production dependencies only for runtime.
- Run as a non-root user if straightforward with the selected image.
- Set:
  ```text
  NODE_ENV=production
  HOST=0.0.0.0
  PORT=8080
  ```
- Do not bake `.env`, keys, or tokens into the image.
- Include an explicit `CMD`.

Test the built image locally before considering the Fly config complete.

---

# 15. Fly configuration expectations

Create a sane `fly.toml`.

Conceptual shape:

```toml
app = "<operator-selected-unique-name>"
primary_region = "sjc"

[env]
  NODE_ENV = "production"
  HOST = "0.0.0.0"
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 0

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  timeout = "5s"
  path = "/health"

[[vm]]
  size = "shared-cpu-1x"
```

Treat the app name and region as operator-configurable rather than hard-coding a name that may already be taken.

For active travel/concierge use later, document that the user may choose:

```text
auto_stop_machines = "off"
min_machines_running = 1
```

to trade a small ongoing compute cost for lower cold-start latency.

---

# 16. Host and origin handling

The current server does:

```js
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map(...)
  .filter(...);

const app = host === '0.0.0.0'
  ? createMcpExpressApp({ host, allowedHosts })
  : createMcpExpressApp();
```

Be careful here.

In the current MCP Express package, explicitly supplying `allowedHosts: []` is different from omitting it. Host validation is applied when `allowedHosts` is supplied.

For Fly, configure the actual Fly hostname, e.g.:

```text
ALLOWED_HOSTS=<app-name>.fly.dev
```

and any custom domain if later added.

If Fly proxy/health-check Host behavior requires an additional host, verify it experimentally rather than weakening validation broadly.

Also evaluate `allowedOrigins` if browser-hosted MCP traffic introduces an `Origin` header.

---

# 17. Fly secrets

Secrets should be configured with Fly secrets, not committed files.

For Stage 1:

```bash
fly secrets set \
  SUPABASE_URL="..." \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  TRAVEL_BRAIN_USER_ID="..." \
  MCP_BEARER_TOKEN="..."
```

For OAuth mode, likely add:

```text
SUPABASE_PUBLISHABLE_KEY
PUBLIC_BASE_URL
```

and reduce/remove service-role dependence.

Do not store:

```text
SUPABASE_SERVICE_ROLE_KEY
MCP_BEARER_TOKEN
```

in `fly.toml`.

---

# 18. Deployment commands

Expected operator workflow should be documented and tested.

Typical shape:

```bash
cd mcp-server

fly launch --no-deploy
# Review / edit fly.toml

fly secrets set ...

fly deploy
```

Post-deploy:

```bash
fly status
fly checks list
fly logs
```

Health:

```bash
curl https://<app>.fly.dev/health
```

---

# 19. Remote MCP verification

After deploying, test remote discovery.

For Stage 1 bearer auth, adapt the Inspector invocation to include the authorization header according to the current Inspector CLI syntax.

The result must contain the same 12 tools as the local server.

Also test a read/write round trip:

1. `list_trips`
2. `create_trip`
3. `list_trips` again

Then test the existing vertical slice:

```text
research
→ plan
→ visit
→ journal
→ recommend
→ learn
```

Use `examples/vertical-slice.md`.

Do not create a new parallel test scenario when the existing one already exercises the intended product invariants.

---

# 20. Required regression tests

At minimum cover these behaviors.

## Authentication

- `/health` succeeds without auth.
- `/mcp` rejects absent token in protected modes.
- `/mcp` rejects invalid token.
- valid caller can invoke tools.
- OAuth mode does not accept a caller as another `actorId`.

## Authorization

- owner can read/edit own trip.
- editor can edit shared trip.
- viewer cannot mutate shared trip.
- unrelated user cannot read trip.
- RLS remains effective in OAuth mode.

## Provenance

- `firsthand` recommendation fails without a visit.
- `firsthand` recommendation succeeds after a visit.

## Memory

- explicit preference defaults to confirmed/high confidence.
- inferred preference defaults to candidate/lower confidence.
- research and semantic memory stay separate.

## Itinerary

- planned timestamps remain intact when actual timestamps are recorded.
- visit completion updates actual timing without destroying plan history.

## Journal

- raw note is preserved verbatim in the appropriate field.
- generated text is not written over `raw_note`.

---

# 21. Observability

Keep logging useful but safe.

Log:

- startup mode,
- port,
- request method/path,
- request ID if added,
- tool name,
- status/duration,
- high-level errors.

Do **not** log:

- Supabase service-role keys,
- bearer tokens,
- OAuth access/refresh tokens,
- private journal text by default,
- full authorization headers.

Add graceful error handling so one malformed tool call does not crash the process.

---

# 22. README/docs changes

Update documentation to cover:

## Local development
- `.env`
- `npm install`
- `npm run dev`
- MCP Inspector test

## Fly staging
- Docker build
- `fly launch`
- Fly secrets
- static bearer auth
- remote Inspector test

## Production auth
- Supabase OAuth 2.1 prerequisites
- MCP protected-resource metadata
- per-user request identity
- RLS model
- any dashboard steps the operator must perform manually

Update `docs/security.md` so it clearly distinguishes:

```text
local development
staging remote
production OAuth
```

---

# 23. Things NOT to implement in this handoff

Unless required to make deployment/auth work, do not expand scope into:

- standalone companion app,
- rich ChatGPT UI,
- map UI,
- booking APIs,
- Google Maps/Places integration,
- weather APIs,
- flight tracking,
- automatic location streaming,
- OpenAI Responses API,
- embeddings worker,
- Mem0,
- pgvector similarity search,
- automatic research web crawler,
- photo journal UI,
- friend-facing public guide UI.

The schema is intentionally ready for several of those later.

This milestone is about making the **existing Travel Brain MCP a safe, reproducible remote service**.

---

# 24. Acceptance criteria

The task is complete when all of the following are true.

## Repository

- [ ] `npm run check` passes.
- [ ] dependencies are reproducible via lockfile.
- [ ] Dockerfile exists and builds.
- [ ] `.dockerignore` prevents secrets/node_modules from entering build context.
- [ ] Fly config exists and is documented.
- [ ] `.env.example` reflects the supported auth modes.
- [ ] security docs are updated.

## Local container

- [ ] container starts on `0.0.0.0:8080`.
- [ ] `/health` returns HTTP 200.
- [ ] `/mcp` lists all 12 tools when authenticated.
- [ ] `/mcp` rejects unauthenticated requests in protected modes.

## Fly

If deployment credentials are available:

- [ ] Fly deploy succeeds.
- [ ] Fly health check passes.
- [ ] public `/health` returns HTTP 200.
- [ ] public `/mcp` is not anonymously writable/readable.
- [ ] remote MCP Inspector can list tools.
- [ ] remote `create_trip` persists to Supabase.
- [ ] subsequent remote `list_trips` returns it.

If credentials are unavailable:

- [ ] all files/config are ready.
- [ ] exact operator commands are documented.
- [ ] no secret values are required in source control.

## Security direction

- [ ] current service-role/fixed-user behavior remains available only in a protected development/staging mode.
- [ ] production design no longer assumes a global `TRAVEL_BRAIN_USER_ID`.
- [ ] code is structured for per-request identity.
- [ ] Supabase OAuth 2.1 integration is implemented or the remaining dashboard/UI dependency is precisely documented.
- [ ] normal OAuth user database calls are designed to be RLS-scoped.

## Product invariants

- [ ] firsthand recommendation enforcement still works.
- [ ] planned-vs-actual timestamps are preserved.
- [ ] raw journal notes remain distinct.
- [ ] semantic memory and research memory remain distinct.
- [ ] no OpenAI API dependency has been introduced.

---

# 25. Recommended implementation sequence

Use this order to reduce risk:

```text
1. Baseline tests / lock dependencies
             ↓
2. Config validation
             ↓
3. Add staging bearer auth
             ↓
4. Dockerize
             ↓
5. Test local Docker MCP
             ↓
6. Add Fly config
             ↓
7. Deploy + remote Inspector test
             ↓
8. Refactor DB functions for request context
             ↓
9. Integrate Supabase OAuth resource-server verification
             ↓
10. Use user JWT for RLS-scoped Supabase access
             ↓
11. Regression + vertical-slice tests
             ↓
12. Update docs / operator steps
```

Do not attempt a large auth refactor and a first-ever cloud deployment simultaneously without preserving a working staging path.

---

# 26. Suggested commit boundaries

Keep work reviewable.

Possible commits:

```text
chore: pin MCP server dependencies and add deployment baseline
feat: add validated server configuration
feat: protect MCP endpoint with staging bearer auth
build: add Docker and Fly.io deployment config
refactor: make Travel Brain database calls request-scoped
feat: add Supabase OAuth MCP authentication
test: add auth and Travel Brain regression coverage
docs: document local, Fly, and OAuth workflows
```

---

# 27. Existing local verification evidence

The following command has already succeeded against the local development server:

```bash
npx @modelcontextprotocol/inspector@latest --cli \
  --server-url http://127.0.0.1:3000/mcp \
  --transport http \
  --method tools/list \
  --format json
```

It returned all 12 tools listed above.

Therefore, if remote deployment fails while the local baseline still passes, investigate:

- Fly bind address,
- internal port,
- Host validation,
- authentication middleware,
- proxy headers,
- Fly secrets,
- startup errors,

before changing the MCP tool implementation.

---

# 28. Relevant implementation notes from current code

## `server.mjs`

Current structure:

- reads `PORT`, `HOST`, `ALLOWED_HOSTS`,
- calls `ensureProfile()` once on startup,
- creates a fresh `McpServer` per request via `createMcpHandler`,
- registers tools,
- mounts all MCP methods at `/mcp`,
- exposes `/health`.

The per-request `McpServer` factory is compatible with moving authentication identity into request context.

## `db.mjs`

Current structure:

- module-global service-role Supabase client,
- module-global actor ID,
- explicit `tripAccess()` checks,
- functions are not request-context aware yet.

This file is the main refactor target for OAuth.

## `tools.mjs`

Current handlers call module-imported DB functions directly.

This file should become the bridge from:

```text
MCP handler context
→ authenticated Travel Brain request context
→ DB function
```

Avoid duplicating auth logic separately in every tool; create a helper.

---

# 29. Human/operator configuration that Codex may not be able to perform

If dashboard access is unavailable, leave exact instructions for the operator.

Likely Supabase production-auth steps include:

1. Enable Supabase OAuth 2.1 Server.
2. Configure the project's authorization path/UI.
3. Decide whether to enable dynamic client registration.
4. Ensure the existing Travel Brain user can authenticate through that flow.
5. Configure any required redirect URIs/client approval behavior.
6. Verify RLS with OAuth-issued JWTs.

Do not weaken server security simply because a dashboard step cannot be automated.

---

# 30. Definition of success for the user

At the end of this handoff, the user should be able to shut down the local Mac development server and have a persistent Travel Brain MCP endpoint available from Fly.io.

The immediate user experience after authentication should be equivalent to the local MCP:

```text
"List my trips."
"Create a trip to Japan."
"Save this place."
"Remember this research."
"Record that we visited it."
"Remember this journal note."
"Recommend it to friends."
```

All of those actions must continue to operate against the same Supabase Travel Brain.

---

# 31. Official references to consult while implementing

Use current primary documentation rather than relying on old examples.

### Model Context Protocol TypeScript SDK
- Express serving and Host/Origin validation
- Bearer/OAuth resource-server authorization
- handler context / `ctx.http.authInfo`

Docs:
- https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html
- https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html

### OpenAI
- Remote MCP / Developer Mode behavior
- MCP/plugin authentication expectations

Docs:
- https://developers.openai.com/api/docs/guides/developer-mode
- https://developers.openai.com/api/docs/mcp
- https://developers.openai.com/plugins/build/auth

### Supabase
- OAuth 2.1 Server
- MCP authentication with Supabase Auth
- token security and RLS
- JWTs / API keys

Docs:
- https://supabase.com/docs/guides/auth/oauth-server
- https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- https://supabase.com/docs/guides/auth/oauth-server/token-security
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/getting-started/api-keys

### Fly.io
- Dockerfile deployment
- `fly.toml`
- launch/deploy
- autostop/autostart
- health checks
- secrets

Docs:
- https://fly.io/docs/languages-and-frameworks/dockerfile/
- https://fly.io/docs/reference/configuration/
- https://fly.io/docs/reference/fly-launch/
- https://fly.io/docs/launch/deploy/
- https://fly.io/docs/launch/autostop-autostart/

---

# 32. Final instruction to Codex

Start by inspecting the repository and verifying that this handoff matches the checked-in code.

If the code has changed since this handoff was written, preserve the **architectural invariants and acceptance criteria**, but adapt implementation details to the actual repository.

Prefer small, testable changes.

Do not silently expose the service-role MCP publicly.

Do not replace Supabase/PostgreSQL with another backend.

Do not introduce OpenAI API usage just to deploy or authenticate the MCP.

When finished, report:

1. files changed,
2. architectural changes,
3. security model,
4. commands executed,
5. test results,
6. Fly endpoint if deployed,
7. remaining manual Supabase/Fly/ChatGPT steps,
8. any risks or deferred work.
