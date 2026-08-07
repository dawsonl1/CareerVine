/**
 * Cache identity for the /companies list, the read behind it, and the one place
 * that knows how to refresh it (CAR-256, CAR-278).
 *
 * Separate from the page so a WRITE can refresh without importing it. The writes
 * that matter happen on the company detail page, at which point the list is
 * unmounted — which is also why this cannot go through the `ui-events` bus:
 * that bus coordinates views that are currently mounted, and there is no
 * listener to receive the event. It is also why the FETCH lives here rather than
 * in the page: an unmounted page cannot supply one.
 */

import { getCompanies, type CompanySort, type CompanySummary } from "@/lib/company-queries";
import { listKeysByPrefix, refreshList } from "@/lib/list-cache";

/**
 * How long a cached list is served without rechecking.
 *
 * Long, because it is not the mechanism that keeps the list correct — every
 * write this app makes to a company row refreshes the cache at the write site
 * (see below). The TTL bounds only what this tab cannot observe: a cron, an MCP
 * call, another tab, a row edited from some surface other than the company
 * detail page. Fifteen minutes is the accepted blind window for those.
 */
export const COMPANIES_LIST_TTL_MS = 15 * 60 * 1000;

/** Every cached sort for one user. */
export function companiesListKeyPrefix(userId: string): string {
  return `companies:${userId}:`;
}

/**
 * Keyed on the SERVER sort, because that is what `getCompanies` takes. The
 * filters are not part of the key and must never be: they are a pure in-memory
 * pass over the same rows, so folding them in would refetch on every keystroke.
 */
export function companiesListKey(userId: string, sort: CompanySort): string {
  return `${companiesListKeyPrefix(userId)}${sort}`;
}

/**
 * The read the /companies list performs. Defined once and called from both the
 * page and the background refresh below, because the two MUST issue the same
 * query — a refresh that fetched a different row set would fill the cache with
 * rows the page would never have asked for, and the page would render them
 * without ever knowing.
 */
export function fetchCompaniesList(userId: string, sort: CompanySort): Promise<CompanySummary[]> {
  // One list: every company you're targeting or already know someone at.
  return getCompanies(userId, { scope: "in_play", sort, minContacts: 1 });
}

/**
 * Drop the cached list after a write that changes what a company row displays,
 * and immediately fetch it again in the background.
 *
 * The refetch is the point (CAR-278). Dropping alone left the cache cold at
 * exactly the moment the user was most likely to go back — they had just changed
 * something — so the trip that CAR-256 made instant went back to costing a full
 * `getCompanies` aggregate. `refreshList` throttles and de-duplicates, so the
 * autosave write sites can call this as often as they like.
 *
 * All sorts, not just the one in view: the user may have been on any of them
 * when they left, and a sort left holding contradicted rows is exactly the bug
 * this prevents. Only sorts this tab has actually loaded are refreshed —
 * warming one the user has never opened would be inventing work.
 */
export function refreshCompaniesList(userId: string): void {
  const prefix = companiesListKeyPrefix(userId);
  for (const key of listKeysByPrefix(prefix)) {
    const sort = key.slice(prefix.length) as CompanySort;
    refreshList(key, () => fetchCompaniesList(userId, sort));
  }
}
