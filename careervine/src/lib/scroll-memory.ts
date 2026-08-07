/**
 * Per-tab scroll memory for list pages, plus the signal that says a mount is a
 * RETURN rather than a fresh visit (CAR-256), plus the row the user left through
 * (CAR-278).
 *
 * Pure and React-free; `use-scroll-restoration.ts` is the React binding.
 *
 * ── Why a saved position is not enough on its own ────────────────────────
 *
 * Restoring purely because a position exists for this URL is wrong: clicking
 * "Companies" in the nav bar is a request to go to the page, and landing
 * mid-list there is disorienting. Only a back/forward navigation should restore.
 *
 * App Router gives no navigation-type signal for a client-side transition —
 * `performance.getEntriesByType("navigation")` only classifies full document
 * loads — so this module listens for `popstate` itself and timestamps it. The
 * listener registers when the module loads, which is before any back navigation
 * a list page could care about: to return to a list you must first have been on
 * it, which loaded this module.
 *
 * The timestamp, rather than a plain boolean, is what stops the signal leaking.
 * A `popstate` onto a page with no consumer would leave a bare flag set forever,
 * and the next FORWARD navigation to a list would wrongly read it as a return.
 * A pop that no one consumed within `POP_WINDOW_MS` is simply no longer a pop.
 */

const KEY_PREFIX = "cv:scroll:";

/**
 * Positions kept per pathname. Small because the only consumer is "the list I
 * just left", and unbounded growth is a real risk otherwise: every keystroke in
 * a search box writes a new `search` string, so an uncapped map would collect
 * one entry per prefix of everything the user has ever typed.
 */
const MAX_ENTRIES = 20;

/**
 * How long after a `popstate` a mount still counts as a return. Generous
 * relative to a client-side transition (which is a re-render, not a load) and
 * far shorter than any plausible gap before a deliberate forward navigation.
 */
const POP_WINDOW_MS = 2000;

/**
 * `[search, scrollY, anchor?]`, oldest first. An array, not a record, so the LRU
 * order is explicit.
 *
 * The third slot is the row the user navigated INTO (CAR-278), and it exists
 * because the offset alone stopped being sufficient once a write started
 * refreshing the list in the background: the rows behind that offset can be
 * reordered or fewer by the time the user comes back, and the default
 * "What's next" sort is precisely the ordering a stage change perturbs.
 *
 * Optional, and read defensively, because entries written by the previous
 * version are two elements long and live in a sessionStorage that outlives the
 * deploy. Discarding those would reset the scroll of every open tab once.
 */
type StoredEntry = [search: string, y: number, anchor?: string];

let lastPopAt = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    lastPopAt = Date.now();
  });
}

/**
 * True when the current mount followed a back/forward navigation, consuming the
 * signal so a single pop can only restore one page.
 */
export function consumePopNavigation(now: number = Date.now()): boolean {
  const popped = lastPopAt !== 0 && now - lastPopAt <= POP_WINDOW_MS;
  lastPopAt = 0;
  return popped;
}

/** Test seam: forge a pop (or clear one) without dispatching a real event. */
export function setLastPopAtForTest(at: number): void {
  lastPopAt = at;
}

function read(pathname: string): StoredEntry[] {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + pathname);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything unexpected degrades to "no memory" rather than throwing into a
    // render: this is a convenience, never a correctness input.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredEntry =>
        Array.isArray(e) && e.length >= 2 && typeof e[0] === "string" && typeof e[1] === "number",
    );
  } catch {
    // sessionStorage unavailable (private mode) or malformed JSON.
    return [];
  }
}

function write(pathname: string, list: StoredEntry[]): void {
  try {
    sessionStorage.setItem(KEY_PREFIX + pathname, JSON.stringify(list));
  } catch {
    // Storage unavailable or full — scroll memory is not worth failing a render.
  }
}

/** Replace this view's entry, moving it to the most-recently-used end. */
function upsert(pathname: string, search: string, next: StoredEntry): void {
  const list = read(pathname).filter(([s]) => s !== search);
  list.push(next);
  write(pathname, list.slice(-MAX_ENTRIES));
}

/** The stored anchor, or null for an entry that has none or a corrupt one. */
function anchorOf(entry: StoredEntry | undefined): string | null {
  return entry && typeof entry[2] === "string" ? entry[2] : null;
}

/**
 * Record `y` for one filtered view of a list.
 *
 * Keyed by `search` as well as `pathname` because a different filter set is a
 * different list: restoring a position measured against 300 rows into a view
 * showing 12 would land past the end.
 *
 * Preserves the anchor. This fires on every scroll frame and the anchor is
 * written once, on the click that leaves the page, so overwriting it here would
 * erase it before the return trip that needs it.
 */
export function rememberScroll(pathname: string, search: string, y: number): void {
  const anchor = anchorOf(read(pathname).find(([s]) => s === search));
  upsert(pathname, search, anchor === null ? [search, y] : [search, y, anchor]);
}

/**
 * Record which row the user is navigating into, so the return trip can find it
 * even if the list has been reordered underneath (CAR-278).
 *
 * Preserves `y` for the same reason `rememberScroll` preserves the anchor: the
 * two are written by different events and neither owns the other's slot.
 */
export function rememberAnchor(pathname: string, search: string, anchor: string): void {
  const prev = read(pathname).find(([s]) => s === search);
  upsert(pathname, search, [search, prev ? prev[1] : 0, anchor]);
}

/** The remembered position for this exact view, or null. */
export function recallScroll(pathname: string, search: string): number | null {
  const found = read(pathname).find(([s]) => s === search);
  return found ? found[1] : null;
}

/**
 * The remembered anchor for this view, CLEARED as it is read.
 *
 * Consumed rather than recalled because it describes one specific round trip:
 * the user clicked this row and is coming straight back. Left in place it would
 * outlive that trip, and a later return — after the user had scrolled somewhere
 * else entirely — would yank them to a row they had moved on from. `y` is the
 * right answer for every visit after the first.
 */
export function consumeAnchor(pathname: string, search: string): string | null {
  const list = read(pathname);
  const found = list.find(([s]) => s === search);
  const anchor = anchorOf(found);
  if (anchor === null) return null;
  // Rewritten in place, not moved to the MRU end: this is a read.
  write(
    pathname,
    list.map((e) => (e[0] === search ? ([e[0], e[1]] as StoredEntry) : e)),
  );
  return anchor;
}

/** Test-only: drop everything remembered for a pathname. */
export function forgetScroll(pathname: string): void {
  try {
    sessionStorage.removeItem(KEY_PREFIX + pathname);
  } catch {
    // Nothing to do — see write().
  }
}
