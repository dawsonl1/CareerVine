// Types for analytics-events.js (a plain JS module shipped as-is by the
// extension). Literal string types let the web app's parity test assert each
// emitted event name is a key of `AnalyticsEvents` (CAR-148 F59). Keep the
// values in sync with analytics-events.js — the parity test guards the union.
export declare const EXTENSION_ANALYTICS_EVENTS: {
  readonly PROFILE_SCRAPED: "profile_scraped";
  readonly EXTENSION_LOGGED_IN: "extension_logged_in";
  readonly EXTENSION_INSTALLED: "extension_installed";
};
