import { describe, it, expect } from "vitest";
import { ok, fail } from "@/mcp/lib/tool-utils";

/**
 * CAR-272 (first half). Every tool response now carries `structuredContent`
 * alongside the text block, so a client can read it as data instead of parsing
 * prose.
 *
 * Purely additive on purpose. The text block is unchanged and still first, so a
 * client reading `content[0].text` — including an agent already connected —
 * sees exactly what it saw before.
 *
 * The declared `outputSchema` half of this ticket is deliberately NOT here. The
 * SDK treats that schema as a runtime contract: it throws when a tool declares
 * one and returns no structured content, and throws again when the content
 * fails to parse. Declaring one therefore needs a harness that proves the
 * handler's real payload matches, and the harness written for it passed locally
 * while failing in CI, so nothing was shipped on the strength of it.
 */

describe("ok()", () => {
  it("keeps the text block first and mirrors it as structured content", () => {
    const res = ok({ summary: "hi", n: 1 });
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(res.content[0].text)).toEqual({ summary: "hi", n: 1 });
    expect(res.structuredContent).toEqual({ summary: "hi", n: 1 });
  });

  it("does not promote arrays or primitives, which are not valid structured content", () => {
    // MCP requires structuredContent to be an object. Every tool here returns
    // one, but the guard keeps a future array-returning tool from emitting
    // something the spec disallows.
    expect(ok([1, 2]).structuredContent).toBeUndefined();
    expect(ok("plain").structuredContent).toBeUndefined();
    expect(ok(null).structuredContent).toBeUndefined();
  });

  it("leaves error results without structured content", () => {
    const res = fail(new Error("boom"));
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(res.content[0].text).toContain("boom");
  });
});
