/**
 * Cache identity for the company DETAIL page's roster, and the one place that
 * knows how to invalidate it (CAR-268).
 *
 * Sibling of `companies-list-cache.ts`, and it caches deliberately LESS than the
 * page loads. `load()` awaits two reads with opposite risk profiles:
 *
 *   * `fetchCompanyScopes` is the expensive one (it fans out to
 *     `getContactStages`' eight legs plus the alumni and email reads) and the
 *     page never mutates it. That is what this caches.
 *   * `loadPipeline` is small, and `usePipelineAutosave` seeds a reducer from it
 *     and writes back on a debounce. It is NOT cached, and must not be: the
 *     autosave's unmount flush writes after a cache entry would have been
 *     stamped, so a note typed inside the debounce window would vanish from the
 *     screen while sitting in the database. Refetching the cheap half every
 *     mount removes that failure class instead of guarding it.
 *
 * Separate from the page so a WRITE can invalidate without importing it — the
 * roster is unmounted at the moment nearly every relevant write happens, which
 * is also why this cannot go through the `ui-events` bus.
 */

import { invalidateListsByPrefix } from "@/lib/list-cache";

/**
 * Shorter than the list's window. The scopes are derived from sixteen tables and
 * several of the writes that touch them happen in other processes entirely
 * (Gmail and calendar sync, the Apify re-scrape webhook, MCP), where there is no
 * client site to invalidate from. For those the TTL is the ONLY bound, so it is
 * set to a couple of minutes rather than five.
 */
export const COMPANY_SCOPES_TTL_MS = 2 * 60 * 1000;

const SCOPES_PREFIX = "company-scopes:";

/** Every cached company roster for one user. */
export function companyScopesKeyPrefix(userId: string): string {
  return `${SCOPES_PREFIX}${userId}:`;
}

export function companyScopesKey(userId: string, companyId: number): string {
  return `${companyScopesKeyPrefix(userId)}${companyId}`;
}

/**
 * Drop every cached company roster in this tab.
 *
 * PREFIX-WIDE, not per-company. A contact holds roles at several companies, and
 * no contact-level write site (an edit, a tier move, a logged conversation, an
 * excluded timeline entry) knows which company pages that person appears on.
 * Dropping only the company the user came from would leave every other cached
 * roster serving a row the user's own action just contradicted.
 *
 * TAKES NO USER, deliberately. The key carries one so the namespace stays
 * correct if the store ever outlives a session, but invalidation sweeps the bare
 * prefix instead, because the callers are the ones that need this to be easy:
 * five of the seven write sites are components with no `userId` in scope
 * (`timeline-detail-modal`, `compose-email-modal`, `discovery-card`, …), and
 * threading an id through them to delete entries that can only belong to the one
 * signed-in user would be ceremony, not safety. The store is in-memory and
 * per-tab, and `signOut` hard-navigates, so a tab only ever holds one user's
 * entries. Over-invalidating is wasteful at worst; under-invalidating shows the
 * user a roster contradicting what they just did.
 */
export function invalidateCompanyScopes(): void {
  invalidateListsByPrefix(SCOPES_PREFIX);
}
