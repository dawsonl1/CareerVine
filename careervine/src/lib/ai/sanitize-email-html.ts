/**
 * Shared email-HTML sanitization (CAR-143, R5.2 output half).
 *
 * Two profiles, one DOMPurify instance:
 *
 * - `sanitizeAiDraftHtml` — the tight allowlist for HTML that comes straight
 *   out of a model. Applied on every AI generation return path so no route
 *   ever hands raw model HTML to the client (extracted from
 *   ai-followup/generate-draft.ts, which previously was the only sanitized
 *   path of four).
 *
 * - `sanitizeStoredEmailHtml` — the broader email-safe profile for
 *   user-supplied bodies at storage chokepoints (follow-up sequences the cron
 *   auto-sends). Permits normal email formatting but strips script/style,
 *   event handlers, forms, and javascript: URLs.
 */

import createDOMPurify from "dompurify";

// Server-side DOMPurify (Node.js doesn't have window.document), built lazily:
// jsdom costs ~130ms to require and ~25ms to construct, and this module is
// reached at module scope from /api/mcp's registerAllTools — so an eager
// instance taxes every MCP cold start even when nothing sanitizes (CAR-176).
// The literal require() keeps jsdom statically analyzable (webpack bundles
// it, nft traces it) while deferring both the load and the construction to
// the first sanitize call.
let purify: ReturnType<typeof createDOMPurify> | null = null;
function getPurify(): ReturnType<typeof createDOMPurify> {
  if (!purify) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require("jsdom");
    const jsdomWindow = new JSDOM("").window;
    // jsdom's Window is structurally incompatible with the DOM lib's Window
    // that DOMPurify expects, and the mismatch is not expressible without
    // inventing a false type. Kept deliberately: rule 43 pins jsdom ^26.1.0
    // for production CJS-require safety, so this surface must not be "fixed"
    // by bumping jsdom or swapping the sanitizer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    purify = createDOMPurify(jsdomWindow as any);
  }
  return purify;
}

/**
 * Tight allowlist for model-generated draft HTML. Lists are included even
 * though the prompts request <p>-only output: models occasionally emit them
 * anyway, and DOMPurify's KEEP_CONTENT would otherwise flatten
 * "<ul><li>one</li><li>two</li></ul>" into the run-together text "onetwo".
 * List tags carry no attributes, so they add no attack surface.
 */
export function sanitizeAiDraftHtml(html: string): string {
  return getPurify().sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "a", "strong", "em", "b", "i", "ul", "ol", "li"],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
}

/**
 * Broader email-safe profile for stored bodies the cron later sends verbatim.
 * DOMPurify's standard HTML profile already drops script, event handlers, and
 * javascript: URLs; forbid style/form machinery on top since an email body
 * never legitimately carries them.
 */
export function sanitizeStoredEmailHtml(html: string): string {
  return getPurify().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "button", "iframe"],
  });
}
