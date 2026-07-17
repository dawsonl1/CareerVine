/**
 * CAR-148 (F59) — the single source of truth for the analytics event names the
 * extension emits. background.js used to pass these as bare string literals with
 * nothing tying them to the web app's `AnalyticsEvents` registry; renaming an
 * event server-side left the extension emitting a dead name silently.
 *
 * UMD-ish so both consumers work with zero build step (the extension ships src/
 * as-is): the classic service worker pulls it in via `importScripts` and reads
 * the `EXTENSION_ANALYTICS_EVENTS` global; the web app's vitest parity test
 * imports it via `module.exports` (through the @ext alias) and asserts every
 * value is a key of `AnalyticsEvents`. A hand-written `analytics-events.d.ts`
 * gives the web app typecheck the literal types.
 */
const EXTENSION_ANALYTICS_EVENTS = Object.freeze({
  PROFILE_SCRAPED: 'profile_scraped',
  EXTENSION_LOGGED_IN: 'extension_logged_in',
  EXTENSION_INSTALLED: 'extension_installed',
});

// Service-worker global (set via importScripts).
if (typeof self !== 'undefined') {
  self.EXTENSION_ANALYTICS_EVENTS = EXTENSION_ANALYTICS_EVENTS;
}
// CommonJS export for the web app's vitest parity test.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EXTENSION_ANALYTICS_EVENTS };
}
