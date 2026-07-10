/**
 * Full-page navigation (not the Next router) — used when all in-memory
 * state should reset, e.g. after sign-out. Lives in its own module so
 * tests can mock it: jsdom's window.location is unforgeable and can't
 * be spied on directly.
 */
export function hardNavigate(path: string) {
  window.location.assign(path);
}
