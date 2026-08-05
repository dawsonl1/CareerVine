/**
 * Per-route request-count measurement for the request-budget guard (CAR-229).
 *
 * ── What this measures, and what it deliberately cannot ───────────────────
 *
 * It counts requests the BROWSER makes during a page load: our own `/api/*`
 * routes, plus anything the browser sends straight at the local Supabase stack's
 * PostgREST endpoint (`/rest/v1/*`). That is the surface an N+1 lives on — one
 * request per rendered row — and it is what the CAR-229 baseline measured:
 * `/companies` 84 requests, `/meetings` 40 (a 15x2 fan-out over meetings), `/`
 * 50, against `/settings`'s healthy floor of 6.
 *
 * It cannot see a SERVER-side sweep. `paginateAll()` over 2,005 contacts is
 * three PostgREST round trips inside one route handler and reaches the browser
 * as a single request, so a whole-table read is invisible here no matter how
 * slow it is. That half is `check-conventions.mjs`'s exhaustive-sweep check;
 * neither guard subsumes the other, and a claim that this one covers "the
 * performance regressions" would be false.
 *
 * ── Settling ──────────────────────────────────────────────────────────────
 *
 * A load is finished when nothing new has been requested for `quietMs`. That is
 * not an arbitrary wait (CONVENTIONS.md section i bans those): the clock is
 * reset by an observed `request` event, so the poll is synchronised to browser
 * traffic and returns as soon as it stops. An N+1 is exactly the shape that
 * keeps resetting it, which is why a fixed sleep would under-count the failure
 * it exists to catch.
 *
 * The `request` event — not `response` — is what gets counted, so a request the
 * page fires and abandons still lands against the budget. A component that
 * starts 40 fetches and drops 30 of them has still cost the server 40.
 */
import type { Page, Request } from "@playwright/test";
import { expect } from "../fixtures/test";

export interface RequestTally {
  /** Total counted requests. */
  total: number;
  /** Normalised endpoint key → how many times it was requested. */
  byEndpoint: Map<string, number>;
}

/**
 * A path segment is an identity when it is a number, a UUID, or an opaque token
 * (Gmail message/thread ids are 16-char hex). Collapsing those is what turns 61
 * separate URLs into one readable `61x GET /api/contacts/:id` line — without it
 * the failure output is a wall of near-identical paths and the fan-out is
 * invisible, which is the exact failure mode this guard exists to make obvious.
 */
function normaliseSegment(seg: string): string {
  if (/^\d+$/.test(seg)) return ":id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
  if (seg.length >= 12 && /^[0-9a-z_-]+$/i.test(seg) && /\d/.test(seg)) return ":id";
  return seg;
}

/**
 * The budget key for a URL, or null when the request is not counted.
 *
 * Counted: our own `/api/*` routes on any loopback origin, and PostgREST reads
 * the browser sends directly to the Supabase stack. Everything else — the HTML
 * document, `/_next/*` chunks, fonts, images, `/auth/v1/*` token refreshes — is
 * not a data read and would only add noise a ceiling then has to absorb.
 */
export function budgetKey(method: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const p = parsed.pathname;
  if (p.startsWith("/api/")) {
    return `${method} ${p.split("/").map(normaliseSegment).join("/")}`;
  }
  if (p.startsWith("/rest/v1/")) {
    // Table name only: PostgREST puts the whole projection in the query string,
    // so keeping it would make every read its own key.
    return `${method} supabase:${p.split("/").map(normaliseSegment).join("/")}`;
  }
  return null;
}

/**
 * Load `path` and tally the data requests it makes, returning once the browser
 * has been quiet for `quietMs`.
 *
 * The page is parked on `about:blank` first so a previous route's in-flight
 * work cannot be charged to this one — without it the first measurement in a
 * file inherits whatever the session-minting navigation was still doing.
 */
export async function measurePageLoad(
  page: Page,
  path: string,
  opts: { quietMs?: number; settleTimeoutMs?: number } = {},
): Promise<RequestTally> {
  const quietMs = opts.quietMs ?? 2_000;
  const settleTimeoutMs = opts.settleTimeoutMs ?? 30_000;

  await page.goto("about:blank");

  const byEndpoint = new Map<string, number>();
  let total = 0;
  let lastActivityAt = Date.now();

  const onRequest = (req: Request) => {
    const key = budgetKey(req.method(), req.url());
    if (!key) return;
    byEndpoint.set(key, (byEndpoint.get(key) ?? 0) + 1);
    total += 1;
    lastActivityAt = Date.now();
  };

  page.on("request", onRequest);
  try {
    await page.goto(path);
    // Reset once more at `load`: a slow document means the pre-navigation
    // timestamp has already aged past quietMs, and the poll would then return
    // before the page's own effects have fired a single request.
    lastActivityAt = Date.now();
    await expect
      .poll(() => Date.now() - lastActivityAt, {
        timeout: settleTimeoutMs,
        intervals: [200],
        message:
          `${path} never went quiet for ${quietMs}ms — it is still requesting data after ` +
          `${settleTimeoutMs}ms. Either the page polls on a short interval, or something ` +
          `is looping. Requests so far:\n${formatTally(byEndpoint)}`,
      })
      .toBeGreaterThanOrEqual(quietMs);
  } finally {
    page.off("request", onRequest);
  }

  return { total, byEndpoint };
}

/** Endpoint → count, worst first, as indented lines. */
export function formatTally(byEndpoint: Map<string, number>): string {
  const rows = [...byEndpoint.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) return "    (no counted requests)";
  const width = String(rows[0][1]).length;
  return rows.map(([key, n]) => `    ${String(n).padStart(width)}x  ${key}`).join("\n");
}
