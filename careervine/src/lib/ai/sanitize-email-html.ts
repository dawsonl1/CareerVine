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
// @ts-expect-error -- jsdom has no bundled types; @types/jsdom is a devDep
import { JSDOM } from "jsdom";

// Server-side DOMPurify (Node.js doesn't have window.document)
const jsdomWindow = new JSDOM("").window;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const purify = createDOMPurify(jsdomWindow as any);

/** Tight allowlist for model-generated draft HTML. */
export function sanitizeAiDraftHtml(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "a", "strong", "em", "b", "i"],
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
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "button", "iframe"],
  });
}
