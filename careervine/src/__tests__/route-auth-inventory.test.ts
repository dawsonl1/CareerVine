/**
 * CAR-140 (F25): route-auth inventory. Every `src/app/api/**​/route.ts` must
 * authenticate through the shared `withApiHandler` wrapper — and, under
 * `/api/admin/`, every handler in the file must be `requireAdmin`-gated — OR
 * appear on the explicit HAND_ROLLED allowlist below, which names the exact
 * mechanism each exception uses. This converts the "privileged routes are
 * verified-correct by convention" state into a CI-enforced invariant:
 *
 *   - add a bare route.ts with no withApiHandler and no allowlist entry → red
 *   - drop `requireAdmin` from any handler in an admin route → red
 *   - delete a hand-rolled route without pruning its allowlist entry → red
 *
 * Assertions are pure string/regex over file text (no module imports), so the
 * test is fast and never executes route side effects.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../app/api");

/**
 * The routes that legitimately do NOT use withApiHandler, each mapped to the
 * mechanism it hand-rolls instead. Keys are paths relative to src/app/api.
 * Keep this list exact — a stale entry (deleted route) turns the suite red.
 */
const HAND_ROLLED: Record<string, string> = {
  // BUNDLE_ADMIN_TOKEN bearer (constant-time), service-role client, no session.
  "admin/ai-access/route.ts": "bundle-admin-token",
  "admin/bundles/publish/route.ts": "bundle-admin-token",
  // QStash signed webhooks — @upstash/qstash Receiver.verify on upstash-signature.
  "cron/data-retention/route.ts": "qstash-signature",
  "cron/discovery/route.ts": "qstash-signature",
  "cron/follow-up-nudges/route.ts": "qstash-signature",
  "cron/scrape-refresh/route.ts": "qstash-signature",
  "cron/send-follow-ups/route.ts": "qstash-signature",
  "cron/send-scheduled-emails/route.ts": "qstash-signature",
  "cron/storage-sweep/route.ts": "qstash-signature",
  "cron/sync-bundles/route.ts": "qstash-signature",
  "queue/bundle-sync/route.ts": "qstash-signature",
  // Apify completion webhook — shared secret via timingSafeEqual (header, CAR-140).
  "apify/run-callback/route.ts": "webhook-secret",
  // One-click unsubscribe — signed HMAC token, intentionally unauthenticated (RFC 8058).
  "notifications/unsubscribe/route.ts": "hmac-token",
  // MCP endpoint — OAuth bearer verified against Supabase JWKS via withMcpAuth.
  "mcp/route.ts": "oauth-jwks",
};

const routeFiles = fg
  .sync("**/route.ts", { cwd: apiDir })
  .sort();

const rel = (f: string) => f; // already relative to apiDir
const count = (text: string, re: RegExp) => (text.match(re) || []).length;
// A withApiHandler *call* is `withApiHandler(` or `withApiHandler<Generics>(` — the
// import (`{ withApiHandler }`) is followed by whitespace/brace, so it never matches.
// Counted via String.match (stateless); never RegExp.test on a /g regex (lastIndex trap).
const WRAPPER_CALL = /\bwithApiHandler\s*[<(]/g;
const usesWrapper = (text: string) => count(text, WRAPPER_CALL) > 0;

describe("route-auth inventory", () => {
  it("finds route files (guards against a broken glob)", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it("every route uses withApiHandler or is an allowlisted hand-rolled exception", () => {
    const offenders: string[] = [];
    for (const f of routeFiles) {
      if (HAND_ROLLED[rel(f)]) continue;
      const text = readFileSync(path.join(apiDir, f), "utf8");
      if (!usesWrapper(text)) offenders.push(rel(f));
    }
    expect(
      offenders,
      `these routes neither use withApiHandler nor are on the HAND_ROLLED allowlist:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every handler under /api/admin/ is requireAdmin-gated (unless machine-token)", () => {
    const offenders: string[] = [];
    for (const f of routeFiles) {
      if (!rel(f).startsWith("admin/")) continue;
      if (HAND_ROLLED[rel(f)]) continue; // machine-token admin routes gate differently
      const text = readFileSync(path.join(apiDir, f), "utf8");
      const handlers = count(text, /\bwithApiHandler\s*[<(]/g);
      const gated = count(text, /requireAdmin:\s*true/g);
      // Each withApiHandler in an admin route must carry requireAdmin: true, so
      // removing the flag from any one handler drops `gated` below `handlers`.
      if (handlers === 0 || gated !== handlers) {
        offenders.push(`${rel(f)} (withApiHandler=${handlers}, requireAdmin=${gated})`);
      }
    }
    expect(
      offenders,
      `admin routes with an un-gated handler:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries (each maps to an existing route)", () => {
    const existing = new Set(routeFiles.map(rel));
    const stale = Object.keys(HAND_ROLLED).filter((k) => !existing.has(k));
    expect(stale, `HAND_ROLLED entries with no matching route file: ${stale.join(", ")}`).toEqual([]);
  });

  it("hand-rolled admin routes are the only admin routes without requireAdmin", () => {
    // Sanity: the machine-token routes really are under admin/ and really lack
    // requireAdmin (so the gate exclusion above is load-bearing, not dead).
    for (const key of ["admin/ai-access/route.ts", "admin/bundles/publish/route.ts"]) {
      const text = readFileSync(path.join(apiDir, key), "utf8");
      expect(usesWrapper(text)).toBe(false);
      expect(text).toContain("isAuthorizedAdminToken");
    }
  });
});
