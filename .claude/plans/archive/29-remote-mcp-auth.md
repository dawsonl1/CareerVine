# Plan 29 — Remote MCP for Everyone (CAR-13)

**Linear:** [CAR-13 — Get MCP server available to everyone](https://linear.app/career-vine/issue/CAR-13/get-mcp-server-available-to-everyone)

## Goal

Turn the local, single-user CareerVine MCP server (plan 26) into a remote,
OAuth-protected MCP server that **any CareerVine user** can connect to from
claude.ai (custom connector) or Claude Code — every session authenticated as
and scoped to that user's own data. Dawson's local stdio setup keeps working
unchanged.

What a user experiences: in claude.ai → Settings → Connectors → "Add custom
connector" → `https://careervine.app/api/mcp` → browser opens CareerVine's
consent page (already logged in → one click "Approve") → Claude now has all
27 CareerVine tools, operating on *their* contacts, *their* Gmail, *their*
outreach queue.

## Research summary (verified 2026-07-08)

Two findings make this much less fiddly than it used to be:

1. **Supabase Auth is now an OAuth 2.1 authorization server** (public beta
   since Nov 2025, free during beta, enabled per-project). It handles the
   authorize/token/registration endpoints, PKCE, refresh-token rotation, and
   Dynamic Client Registration. Access tokens are **ordinary Supabase JWTs**
   (`sub` = `auth.users.id`), verifiable statelessly via the project's JWKS.
   We do not build or host an authorization server.
   Docs: <https://supabase.com/docs/guides/auth/oauth-server/getting-started>,
   <https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication>

2. **Vercel's `mcp-handler` package (v1.1.x)** mounts an MCP server inside a
   Next.js route handler with Streamable HTTP, and ships the two auth pieces
   the MCP spec demands of a resource server: `withMcpAuth` (bearer-token
   verification + spec-correct 401/`WWW-Authenticate`) and
   `protectedResourceHandler` (RFC 9728 metadata endpoint).
   Docs: <https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel>,
   <https://github.com/vercel/mcp-handler/blob/main/docs/AUTHORIZATION.md>

### Spec/client facts that shape the design

- Current MCP spec revision is **2025-11-25**. A resource server MUST serve
  Protected Resource Metadata (RFC 9728) pointing at its authorization
  server(s), and SHOULD 401 with
  `WWW-Authenticate: Bearer resource_metadata="…"`. Clients discover the AS
  from that metadata. OAuth 2.1 + PKCE S256 everywhere.
- Clients try the **path-suffixed** well-known first
  (`/.well-known/oauth-protected-resource/api/mcp`), then root. Serve both.
- **claude.ai custom connectors**: available on all plans (Free = 1
  connector). Callback URLs `https://claude.ai/api/mcp/auth_callback` and
  (future) `https://claude.com/api/mcp/auth_callback`. Registers itself via
  DCR (or manual client ID under Advanced settings). 10s timeout on
  discovery/token endpoints; traffic egresses from `160.79.104.0/21`.
- **Claude Code**: `claude mcp add --transport http careervine
  https://careervine.app/api/mcp`, then `/mcp` → browser OAuth. Uses an
  RFC 8252 **loopback redirect with an ephemeral port**, so it effectively
  requires DCR (it registers its actual `http://localhost:<port>/callback`
  each time). Pre-registered fixed redirect URIs alone won't cover it.
- Anthropic's #1 cited failure mode with third-party IdPs (they name
  Supabase specifically) is **issuer mismatch**: metadata `issuer` must equal
  the `iss` claim in tokens — `https://<ref>.supabase.co/auth/v1`. Never
  proxy or rewrite it.
- The **2026-07-28 spec RC** removes `Mcp-Session-Id`/initialize-handshake
  session coupling. We build **stateless** (no sessions, no Redis), which is
  both the simple option today and the forward-compatible one.
- Token-passthrough is explicitly forbidden by the spec — we never forward
  Claude's token upstream. Gmail/Calendar calls use **our own stored Google
  OAuth tokens** from `gmail_connections`, which is exactly the spec-correct
  pattern (and already built).

### Why not the alternatives

- **Hand-rolled AS / SDK `ProxyOAuthServerProvider`**: Express-oriented,
  frozen as legacy in SDK v2, and we'd own token storage, rotation, DCR, and
  consent-security. Escape hatch only.
- **Better Auth / Clerk / WorkOS / Auth0**: all require migrating or
  mirroring the user base out of Supabase Auth. Non-starter — users *are*
  Supabase users.
- **Separate host (Oracle VM / Cloudflare Worker)**: loses direct reuse of
  `careervine/src` libs (gmail, email-send, company-queries) that the tools
  are built on, plus adds a deploy surface. Vercel route in the app wins.

## Architecture

```
Claude (claude.ai / Claude Code)
  │  Streamable HTTP + Bearer <Supabase JWT>
  ▼
careervine.app (Next.js on Vercel)
  ├─ /api/mcp ................................ MCP endpoint (mcp-handler, stateless)
  │    withMcpAuth → verify JWT via Supabase JWKS → userId = sub
  │    runWithUser(userId) → registerXTools (same 27 tools)
  ├─ /.well-known/oauth-protected-resource[/api/mcp]  RFC 9728 metadata
  ├─ /oauth/consent .......................... approve/deny page (new)
  └─ existing app
        │ service-role client, queries hand-scoped to userId (unchanged model)
        ▼
Supabase ── Auth = OAuth 2.1 AS (authorize/token/DCR/JWKS)
        └── data + gmail_connections (per-user Google tokens)
```

**Auth flow** (all standard, no custom protocol code):
1. Claude POSTs to `/api/mcp` with no token → 401 +
   `WWW-Authenticate: Bearer resource_metadata="https://careervine.app/.well-known/oauth-protected-resource/api/mcp"`.
2. Claude fetches PRM → learns AS = `https://<ref>.supabase.co/auth/v1` →
   fetches AS metadata at
   `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`.
3. Claude registers itself (DCR), opens browser to Supabase
   `/oauth/authorize` (PKCE S256).
4. Supabase 302s to `https://careervine.app/oauth/consent?authorization_id=…`;
   the logged-in user approves; Supabase redirects back to Claude's callback
   with the code; Claude exchanges it at `/oauth/token`.
5. Every subsequent MCP request carries `Authorization: Bearer <JWT>`; we
   verify signature/iss/exp against the JWKS locally (no network per
   request) and scope everything to `sub`.

**Per-user scoping model — decision**: keep the service-role client with
explicit hand-scoping (every query `.eq("user_id", uid())`, pinned by the
existing `db-scoping` tests), and make `uid()` **per-request** via
`AsyncLocalStorage`. Considered switching to an RLS-enforced client per
request (Supabase OAuth JWTs would support it) — rejected for now because the
reused app libs (`gmail.ts`, `email-send.ts`, admin lookups) are
service-client-based, and mixing the two models in one request is more
dangerous than one consistently-applied explicit-scoping rule. Revisit if the
tool surface grows.

## Implementation

### Phase 1 — Flip the code dependency direction (no behavior change)

The blocker for hosting in the app: `careervine-mcp/` imports *into*
`careervine/src` via a tsx path alias, and Vercel builds the `careervine/`
app — it can't compile route handlers that import from a sibling package
outside the app.

1. Move the reusable core into the app tree at `careervine/src/mcp/`:
   - `lib/db.ts`, `lib/dossier.ts`, `lib/email-policy.ts`,
     `lib/markdown.ts`, `lib/tool-utils.ts` → `careervine/src/mcp/`
   - `tools/{contacts,email,outreach,upkeep,calendar}.ts` →
     `careervine/src/mcp/tools/`
   - Their `@/*` imports keep working (same alias inside the app).
2. `careervine-mcp/` shrinks to the **stdio shell**: `server.ts`
   (env bootstrap + `initDb` + register + stdio transport), `lib/env.ts`,
   `scripts/e2e.ts`. It imports the moved modules via the existing
   `@/*` → `../careervine/src/*` alias. `.mcp.json` unchanged.
3. Move `careervine-mcp/__tests__/*` under `careervine/src/mcp/__tests__/`
   (vitest already scans `src/**`; drop the cross-package include and the
   `pretest` install hook once nothing in `careervine-mcp` is imported by
   tests).
4. Type-check both entry points; run the stdio e2e smoke
   (`npx tsx scripts/e2e.ts "google"`) to prove no regression.

### Phase 2 — Per-request user context

1. New `careervine/src/mcp/user-context.ts`:
   ```ts
   const als = new AsyncLocalStorage<{ userId: string }>();
   export const runWithUser = <T>(userId: string, fn: () => T) => als.run({ userId }, fn);
   export const currentUserId = () => als.getStore()?.userId ?? fallbackUserId; // stdio sets fallback
   ```
2. `db.ts`: `uid()` reads `currentUserId()`; `initDb(uid)` (stdio path) sets
   the fallback instead of a hard global. `db()`/`setCompanyQueriesClient`
   stay singletons — the service client is user-agnostic; **only the user id
   is request-scoped** (`company-queries.ts` is already fully
   userId-parameterized).
3. New tests: two interleaved `runWithUser` contexts never observe each
   other's id (async gaps included); stdio fallback still works; `uid()`
   throws when neither is set.

### Phase 3 — Supabase project configuration (dashboard + config.toml)

Local first (`supabase/config.toml`), then production dashboard:

1. **Migrate JWT signing keys to asymmetric (ECC/RSA)** — required for the
   OAuth server and for local JWKS verification. Low risk for us: the app
   validates sessions via `supabase.auth.getUser()` (network call), never the
   shared secret; grep confirmed no `SUPABASE_JWT_SECRET` usage anywhere.
2. Enable the OAuth server:
   ```toml
   [auth.oauth_server]
   enabled = true
   authorization_url_path = "/oauth/consent"
   allow_dynamic_registration = true
   ```
   Dashboard equivalents: Authentication → OAuth Server. **DCR on** is
   required for Claude Code's ephemeral loopback ports (and lets claude.ai
   self-register). Known dashboard bug
   ([supabase/auth#2408](https://github.com/supabase/auth/issues/2408)): the
   Authorization Path setting is sometimes missing and the flow hardcodes
   `{SITE_URL}/oauth/consent` — so we build the page at exactly that path.
3. Confirm Site URL = `https://careervine.app`.
4. No secrets change hands: token verification uses the public JWKS URL.

### Phase 4 — HTTP endpoint + auth in the app

New deps in `careervine/`: `mcp-handler`, `jose`; bump
`@modelcontextprotocol/sdk` to match mcp-handler's peer (1.26+, currently
^1.17 in careervine-mcp — upgrade both, check the changelog for
`registerTool` signature drift).

1. **`careervine/src/mcp/verify-token.ts`** — `jose.jwtVerify` with
   `createRemoteJWKSet(https://<ref>.supabase.co/auth/v1/.well-known/jwks.json)`
   (module-level, caches keys); assert `iss === https://<ref>.supabase.co/auth/v1`,
   `exp` (jose enforces), `sub` present, and — if Supabase sets a usable
   `aud`/`resource` — assert it matches `https://careervine.app/api/mcp`
   (**verify empirically in Phase 6**; Supabase's RFC 8707 handling is
   undocumented; fall back to `client_id`-presence + iss checks per their
   docs). Returns `AuthInfo` with `extra.userId = sub`. Reject
   `role !== "authenticated"` (never accept anon/service tokens).
2. **`careervine/src/app/api/mcp/route.ts`**:
   ```ts
   const handler = createMcpHandler(server => { registerContactTools(server); …all 5… },
     {}, { basePath: "/api", maxDuration: 60, disableSse: /* stateless */ });
   const authed = withMcpAuth(handler, verifyToken, {
     required: true,
     resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
   });
   // wrap: authenticated request → ALS
   export const POST = (req) => withUserFromAuth(req, authed); // runWithUser(sub, …)
   export { GET, DELETE } … same wrapper; export const maxDuration = 60;
   ```
   Stateless Streamable HTTP only — no Redis, no session store, and it
   matches where the 2026-07-28 spec is going. Runtime: Node (ALS +
   googleapis), Fluid compute default is fine.
3. **PRM metadata routes** (serve **both** paths, each with CORS + OPTIONS
   via `metadataCorsOptionsRequestHandler`):
   - `careervine/src/app/.well-known/oauth-protected-resource/route.ts`
   - `careervine/src/app/.well-known/oauth-protected-resource/api/mcp/route.ts`
   Both via `protectedResourceHandler({ authServerUrls: ["https://<ref>.supabase.co/auth/v1"] })`
   — the issuer URL **with** the `/auth/v1` path, never rewritten.
4. **Env**: reuse `NEXT_PUBLIC_SUPABASE_URL` for issuer/JWKS derivation; add
   `NEXT_PUBLIC_APP_URL=https://careervine.app` for the PRM `resource` value
   (must be the canonical lowercase URL, no trailing slash).

### Phase 5 — Consent page (`/oauth/consent`)

New `careervine/src/app/oauth/consent/page.tsx` (+ small client component):

1. Read `authorization_id` from the query; not logged in → redirect to login
   with `next=` back to consent (existing auth redirect pattern).
2. `supabase.auth.oauth.getAuthorizationDetails(id)` → client name ("Claude"),
   requested identity scopes.
3. Approve / Deny buttons → `approveAuthorization(id)` /
   `denyAuthorization(id)` → follow the returned redirect.
4. UX (rule 5): CareerVine branding, one screen, plain copy — "**Claude**
   wants to access your CareerVine account (contacts, email drafts/sends,
   outreach queue, calendar). You can disconnect anytime from Claude's
   settings." Show the signed-in email + "switch account". No clutter.
5. Note in copy that email sending stays capped (100/day) and drafts are the
   default — the app/MCP shared policy (`sendTrackedEmail`) already enforces
   this server-side per user.

### Phase 6 — End-to-end verification (the fiddly 20%)

Order matters — cheapest client first:

1. **MCP Inspector** (`npx @modelcontextprotocol/inspector`) against a
   `vercel dev`/preview deploy: full OAuth dance, list tools, read-only calls.
   Fix CORS/metadata issues here (expose `WWW-Authenticate` in
   `Access-Control-Expose-Headers`).
2. **Decode a real issued JWT** and pin down `aud`/`resource`/`client_id`
   claims → finalize `verify-token.ts` assertions accordingly.
3. **Claude Code**: `claude mcp add --transport http careervine
   https://careervine.app/api/mcp` → `/mcp` authenticate. This exercises the
   **highest-risk item**: Supabase's exact-match redirect URIs vs Claude
   Code's ephemeral loopback port. DCR should sidestep it (Claude Code
   registers its real port per session); if Supabase rejects repeated
   registrations or loopback URIs, fallback options: (a) file/verify against
   [supabase discussion #41695](https://github.com/orgs/supabase/discussions/41695),
   (b) front the AS metadata with a thin proxy that relaxes loopback
   matching — last resort only.
4. **claude.ai custom connector** (Pro plan): add connector, approve, run the
   read-only smoke prompts from the README, then a full workflow (dossier →
   draft). Verify token refresh by leaving the connector idle past expiry
   (~1h) and confirming silent refresh.
5. **Negative tests**: no token → 401 with correct `WWW-Authenticate`;
   garbage/expired token → 401 (never 400 — a 400 stalls client re-auth);
   valid token, other user's `contact_id` → ownership error (existing
   scoping guards).

### Phase 7 — Tests, docs, product surface

1. **Unit tests** (vitest, in-app now):
   - `verify-token`: valid/expired/wrong-iss/wrong-role/missing-sub (jose can
     sign test JWTs against a local key pair; inject the JWKS).
   - ALS scoping tests from Phase 2; existing `db-scoping` suite carries over
     untouched (the invariant is unchanged).
   - PRM route returns correct `resource` + `authorization_servers`.
   - Consent page: renders details, deny path, unauthenticated redirect.
2. **Rate limiting / abuse** (small but real now that it's public): per-user
   token-bucket on tool calls inside the handler (e.g. 60 calls/min via an
   in-memory map is *not* enough on serverless — piggyback on Upstash
   (`@upstash/qstash` already in deps means an Upstash account exists;
   add `@upstash/ratelimit` + Redis) or defer with an explicit note that
   send/draft caps already bound the damaging operations).
3. **Docs**: rewrite `careervine-mcp/README.md` around the two modes (hosted
   remote = default for everyone; local stdio = dev mode), with connect
   instructions for claude.ai and Claude Code. Update the product README
   (rule 7): "Connect Claude to CareerVine" section — what it does for the
   user, one paragraph, connect steps.
4. **In-app surface**: add a "Connect Claude" card in Settings with the MCP
   URL, copy-to-clipboard, and the two-step claude.ai instructions. (Users
   will never find a bare URL on their own — this is the feature's front
   door.)
5. Linear: move CAR-13 through In Progress → Done with a comment linking the
   plan and the settings screenshot.

## Risks & open questions

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Supabase OAuth server is **beta** | Med | Feature-flag the settings card; stdio mode unaffected if it breaks; beta is free on all plans |
| Claude Code loopback-port redirect vs Supabase exact matching | **High** (for the CLI client) | DCR enabled; verify in Phase 6 step 3 before announcing; claude.ai unaffected |
| `aud`/`resource` behavior undocumented in Supabase tokens | Med | Empirically pin in Phase 6 step 2; enforce iss+role+client_id minimum |
| Spec revision 2026-07-28 lands mid-build (drops sessions/initialize) | Low | Stateless design already matches; mcp-handler will track; pin versions |
| No custom scopes in Supabase OAuth (identity scopes only) | Low | Acceptable: consent = "act as you"; per-tool safety lives in tool design (confirm-to-send, no deletes); revisit read-only scope later |
| JWT key migration side effects | Low | App uses `getUser()` not the shared secret; migrate first, watch sessions |
| Public endpoint abuse | Med | Auth required for everything; send caps per-user; rate limiting in Phase 7.2 |
| Vercel duration limits on long tool calls (Gmail sync paths) | Low | `maxDuration: 60`; tools are seconds-long; no SSE resumability needed |

## Explicitly out of scope

- Multi-provider AS (only Supabase-authenticated CareerVine users).
- Read-only/granular scopes (Supabase can't express them yet).
- MCP resources/prompts surface, tool changes, or new tools.
- Publishing to Anthropic's connector directory (worth a follow-up ticket
  once stable — `mcp-review@anthropic.com`).

## Rough sequencing / effort

| Phase | Size |
| --- | --- |
| 1 Code move (dependency flip) | ~half day, mostly mechanical + test moves |
| 2 ALS user context | small |
| 3 Supabase config + key migration | small, careful |
| 4 Route + verify + PRM | ~1 day incl. version bumps |
| 5 Consent page | ~half day |
| 6 E2E across 3 clients | the unpredictable part — budget a day |
| 7 Tests/docs/settings card | ~1 day |

## Key references

- MCP authorization spec (2025-11-25): <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- Anthropic connector auth + troubleshooting: <https://claude.com/docs/connectors/building/authentication>
- Supabase OAuth server: <https://supabase.com/docs/guides/auth/oauth-server/getting-started> · MCP guide: <https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication>
- mcp-handler: <https://github.com/vercel/mcp-handler> · Vercel MCP docs: <https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel>
- Claude Code MCP: <https://code.claude.com/docs/en/mcp>
