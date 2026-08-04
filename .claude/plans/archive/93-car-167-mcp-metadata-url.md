# CAR-167: Fix malformed resource_metadata URL in MCP 401 challenge

## Problem

`POST /api/mcp` without credentials returns a 401 whose `WWW-Authenticate` header advertises
`resource_metadata="https://www.careervine.app/api/mcp/.well-known/oauth-protected-resource/api/mcp"` —
a nonexistent URL (404). Clients still connect because RFC 9728 defines a default metadata
location they fall back to, but the advertised URL should be the real one:
`https://www.careervine.app/.well-known/oauth-protected-resource/api/mcp`.

## Root cause

mcp-handler's `withMcpAuth` builds the URL as `resourceUrl + resourceMetadataPath` — the
`resourceUrl` option is used purely as the **origin** prefix (`dist/index.js`:
`const origin = resourceUrl ?? getPublicOrigin(req); const resourceMetadataUrl = origin + resourceMetadataPath`).
`route.ts` passes `getMcpResourceUrl()` (origin **+ `/api/mcp`**), so the resource path is doubled in.

The other consumer of `getMcpResourceUrl()` — `prm-handler.ts`'s `protectedResourceHandler` —
is correct and unchanged: there `resourceUrl` populates the metadata document's `resource`
field, which must be the full resource URL.

## Change

1. `src/app/api/mcp/route.ts`: pass `resourceUrl: getAppOrigin()` to `withMcpAuth`, with a
   comment noting mcp-handler treats this option as the origin prefix for
   `resourceMetadataPath` (misleadingly named upstream). Swap the import accordingly.
2. New test `src/mcp/__tests__/mcp-auth-challenge.test.ts`: contract test against the
   installed `mcp-handler` — invoke `withMcpAuth` with our exact config (origin +
   `resourceMetadataPath`) and a rejecting verifier, POST an unauthenticated Request, and
   assert the 401's `WWW-Authenticate` advertises exactly
   `${origin}/.well-known/oauth-protected-resource/api/mcp` (and not the doubled-path URL).
   This also catches any upstream change to the URL-construction contract on future
   mcp-handler bumps.

## Verification

- `npm run test` from `careervine/` (full suite).
- `npm run build`.
- After merge + deploy: `curl -s -D - -o /dev/null -X POST https://www.careervine.app/api/mcp`
  shows the corrected `resource_metadata` URL, and `GET` on that URL returns 200.

## Risk

Small config-value change on a risky surface (MCP OAuth). The metadata endpoint itself, PRM
document, token verification, and consent flow are untouched. Worst case equals status quo:
clients already ignore the bad URL via the spec fallback.
