// @vitest-environment node
/**
 * CAR-176: jsdom must load lazily. sanitize-email-html is reached at module
 * scope from /api/mcp's registerAllTools, so an eager `new JSDOM()` taxes
 * every MCP cold start (~130ms require + ~25ms construct) even when nothing
 * sanitizes. This suite pins the contract: importing the module must not
 * load jsdom; the first sanitize call loads and constructs it exactly once.
 *
 * The lazy path is a literal CJS `require("jsdom")`, so laziness is observed
 * through Node's shared require cache rather than vi.mock (which only
 * intercepts the ESM import registry, not a runtime require).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

const jsdomCached = () =>
  Object.keys(nodeRequire.cache ?? {}).some((p) => /[\\/]node_modules[\\/]jsdom[\\/]/.test(p));

describe("sanitize-email-html lazy jsdom (CAR-176)", () => {
  it("does not load jsdom at import time, then loads it on first sanitize call", async () => {
    // Self-sufficiency guard: if anything in this worker already required
    // jsdom, evict it so the assertion below observes THIS module's behavior.
    for (const key of Object.keys(nodeRequire.cache ?? {})) {
      if (/[\\/]node_modules[\\/]jsdom[\\/]/.test(key)) delete nodeRequire.cache[key];
    }

    const mod = await import("@/lib/ai/sanitize-email-html");
    expect(jsdomCached()).toBe(false);

    expect(mod.sanitizeAiDraftHtml("<p>hi<script>bad()</script></p>")).toBe("<p>hi</p>");
    expect(jsdomCached()).toBe(true);

    // Memoized: the second profile reuses the same DOMPurify instance and
    // still enforces its own config (no cross-profile bleed).
    expect(mod.sanitizeStoredEmailHtml('<b>keep</b><style>x{}</style>')).toBe("<b>keep</b>");
  });
});
