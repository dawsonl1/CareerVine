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

const LIST_PREFIX = "companies:";

/** Every cached sort for one user. */
export function companiesListKeyPrefix(userId: string): string {
  return `${LIST_PREFIX}${userId}:`;
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
 * write sites can call this as often as they like, and it is a no-op on a tab
 * that has never opened /companies.
 *
 * All sorts, not just the one in view: the user may have been on any of them
 * when they left, and a sort left holding contradicted rows is exactly the bug
 * this prevents. Only sorts this tab has actually loaded are refreshed —
 * warming one the user has never opened would be inventing work.
 *
 * `userId` IS OPTIONAL, and most callers omit it. Same problem
 * `invalidateCompanyScopes()` solved the same way: the writes that change a
 * company row happen in components with no user in scope (a conversation logged
 * from a contact page, an email sent from the compose modal, a candidate added
 * from a discovery card), and threading an id through them to refresh entries
 * that can only belong to the one signed-in user would be ceremony, not safety.
 * The store is in-memory and per-tab and `signOut` hard-navigates, so a tab only
 * ever holds one user's keys. The refetch takes its user from the KEY either
 * way, so an omitted argument never widens what is read.
 */
export function refreshCompaniesList(userId?: string): void {
  const prefix = userId ? companiesListKeyPrefix(userId) : LIST_PREFIX;
  for (const key of listKeysByPrefix(prefix)) {
    // `companies:<userId>:<sort>`, and neither part can contain a colon.
    const [, keyUserId, sort] = key.split(":");
    if (!keyUserId || !sort) continue;
    refreshList(key, () => fetchCompaniesList(keyUserId, sort as CompanySort));
  }
}
