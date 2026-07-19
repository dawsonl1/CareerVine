/**
 * Guard against the CAR-166 outage class: Vercel's production function
 * runtime cannot `require()` ES modules (it behaves like Node with
 * `--no-experimental-require-module`), so any runtime dependency whose CJS
 * chain requires an ESM-only package crashes every importing route at cold
 * start — jsdom@29's html-encoding-sniffer → @exodus/bytes chain took down
 * /api/mcp and all AI-draft/follow-up routes for two days before CAR-166.
 *
 * These tests load the server-side sanitizer chain in a child Node process
 * with require(esm) disabled, reproducing the production constraint exactly.
 * A dependency bump that reintroduces an ESM-from-CJS edge fails here in CI
 * instead of 500ing in production.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

function loadUnderProdConstraint(script: string): string {
  return execFileSync(
    process.execPath,
    ["--no-experimental-require-module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("serverless require safety (CAR-166)", () => {
  it("jsdom + dompurify chain loads without require(esm)", () => {
    const out = loadUnderProdConstraint(`
      const { JSDOM } = require("jsdom");
      const createDOMPurify = require("dompurify");
      const purify = createDOMPurify(new JSDOM("").window);
      if (typeof purify.sanitize !== "function") throw new Error("no sanitize");
      process.stdout.write("ok");
    `);
    expect(out).toBe("ok");
  });

  it("sanitization profiles behave correctly on the CJS-safe chain", () => {
    const out = loadUnderProdConstraint(`
      const { JSDOM } = require("jsdom");
      const createDOMPurify = require("dompurify");
      const purify = createDOMPurify(new JSDOM("").window);
      const draft = purify.sanitize(
        '<p onclick="x()">hi<script>bad()<\\/script></p><ul><li>a</li></ul>',
        { ALLOWED_TAGS: ["p", "br", "a", "strong", "em", "b", "i", "ul", "ol", "li"],
          ALLOWED_ATTR: ["href", "target", "rel"] },
      );
      const stored = purify.sanitize(
        '<div><style>x{}</style><form><input></form><b>keep</b><a href="javascript:alert(1)">l</a></div>',
        { USE_PROFILES: { html: true },
          FORBID_TAGS: ["style", "form", "input", "textarea", "select", "button", "iframe"] },
      );
      process.stdout.write(JSON.stringify({ draft, stored }));
    `);
    const { draft, stored } = JSON.parse(out);
    expect(draft).toBe("<p>hi</p><ul><li>a</li></ul>");
    expect(stored).toBe("<div><b>keep</b><a>l</a></div>");
  });
});
