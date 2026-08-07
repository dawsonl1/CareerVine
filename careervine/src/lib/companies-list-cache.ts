/**
 * Cache identity for the /companies list, and the one place that knows how to
 * invalidate it (CAR-256).
 *
 * Separate from the page so a WRITE can invalidate without importing it. The
 * writes that matter happen on the company detail page, at which point the list
 * is unmounted — which is also why this cannot go through the `ui-events` bus:
 * that bus coordinates views that are currently mounted, and there is no
 * listener to receive the event.
 */

import { invalidateListsByPrefix } from "@/lib/list-cache";
import type { CompanySort } from "@/lib/company-queries";

/**
 * How long a cached list is served without rechecking. Matches the home page's
 * SWR window (`src/app/page.tsx`), and is the outer bound on staleness for any
 * change this app does not explicitly invalidate on — a company edited from
 * somewhere other than its detail page, or a row changed by a cron.
 */
export const COMPANIES_LIST_TTL_MS = 5 * 60 * 1000;

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
 * Drop the cached list after a write that changes what a company row displays.
 *
 * All sorts, not just the one in view: the user may have been on any of them
 * when they left, and a sort left holding contradicted rows is exactly the bug
 * this prevents.
 */
export function invalidateCompaniesList(userId: string): void {
  invalidateListsByPrefix(companiesListKeyPrefix(userId));
}
