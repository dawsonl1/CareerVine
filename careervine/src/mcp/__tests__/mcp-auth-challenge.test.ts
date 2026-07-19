/**
 * Contract test for the 401 challenge's resource_metadata URL (CAR-167).
 *
 * mcp-handler's withMcpAuth builds the advertised metadata URL as
 * `resourceUrl + resourceMetadataPath` — the misleadingly-named resourceUrl
 * option is the ORIGIN prefix, not the protected resource's URL. Passing the
 * full resource URL (origin + /api/mcp) doubled the path into a nonexistent
 * URL, and clients only connected via the RFC 9728 default-location fallback.
 *
 * This exercises the installed mcp-handler with the exact config shape
 * route.ts uses, so an upstream change to the URL-construction contract fails
 * here on a future bump instead of silently mis-advertising in production.
 */

import { describe, it, expect } from "vitest";
import { withMcpAuth } from "mcp-handler";

const ORIGIN = "https://www.careervine.app";
const METADATA_PATH = "/.well-known/oauth-protected-resource/api/mcp";

function challengeFor(resourceUrl: string): Promise<Response> {
  const handler = withMcpAuth(
    async () => new Response("unreachable", { status: 500 }),
    async () => undefined, // reject every token — we only want the 401
    {
      required: true,
      resourceMetadataPath: METADATA_PATH,
      resourceUrl,
    },
  );
  return handler(
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    }),
  );
}

describe("MCP 401 challenge resource_metadata (CAR-167)", () => {
  it("advertises the real well-known URL when given the origin (route.ts config)", async () => {
    const res = await challengeFor(ORIGIN);
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate") ?? "";
    expect(header).toContain(`resource_metadata="${ORIGIN}${METADATA_PATH}"`);
  });

  it("documents the trap: passing the full resource URL doubles the path", async () => {
    const res = await challengeFor(`${ORIGIN}/api/mcp`);
    const header = res.headers.get("WWW-Authenticate") ?? "";
    expect(header).toContain(
      `resource_metadata="${ORIGIN}/api/mcp${METADATA_PATH}"`,
    );
  });
});
