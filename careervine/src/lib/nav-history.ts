/**
 * Per-tab in-app navigation tracking for "Back" affordances.
 *
 * Client-side route changes don't update document.referrer, so referrer
 * checks can't tell "arrived here from inside the app" (router.back()
 * is right) from "landed here directly" (fall back to a default route).
 * Navigation renders on every page and records the pathname trail in
 * sessionStorage; detail pages ask hasInAppBackHistory() before calling
 * router.back().
 */

const CURRENT_KEY = "cv:nav:current";
const PREVIOUS_KEY = "cv:nav:previous";

/** Record a pathname visit. Call on every route render (Navigation does). */
export function trackPathForBackNav(pathname: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = sessionStorage.getItem(CURRENT_KEY);
    if (current && current !== pathname) {
      sessionStorage.setItem(PREVIOUS_KEY, current);
    }
    sessionStorage.setItem(CURRENT_KEY, pathname);
  } catch {
    // sessionStorage unavailable (private mode) — back falls back to default
  }
}

/** True when this tab reached the current page from another in-app page. */
export function hasInAppBackHistory(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(PREVIOUS_KEY) != null;
  } catch {
    return false;
  }
}
