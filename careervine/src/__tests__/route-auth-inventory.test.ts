/**
 * CAR-140 (F25): route-auth inventory. Every HTTP handler in every
 * `src/app/api/**​/route.ts` must authenticate through the shared `withApiHandler`
 * wrapper — and, under `/api/admin/`, every handler must additionally be
 * `requireAdmin`-gated — OR the route appears on the explicit HAND_ROLLED
 * allowlist below, which names the exact mechanism each exception uses. This
 * converts the "privileged routes are verified-correct by convention" state into
 * a CI-enforced invariant. It counts HTTP-method exports (GET/POST/PUT/PATCH/
 * DELETE/HEAD — OPTIONS is the CORS preflight and excluded) and asserts
 * methodExports === withApiHandler calls (=== requireAdmin under admin/), so a
 * bare handler can't hide beside a wrapped one:
 *
 *   - add a bare route.ts with no withApiHandler and no allowlist entry → red
 *   - append a bare `export async function DELETE(){…}` beside a wrapped handler → red
 *   - drop `requireAdmin` from any admin handler → red
 *   - delete a hand-rolled route without pruning its allowlist entry → red
 *
 * Assertions are pure string/regex over file text (no module imports), so the
 * test is fast and never executes route side effects.
 */

import { existsSync, readFileSync } from "node:fs";
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
  // QStash signed webhooks — shared withQStashVerification (src/lib/qstash-verify.ts)
  // over the upstash-signature header; refuses 401 when signing keys are unset.
  "cron/data-retention/route.ts": "qstash-signature",
  "cron/detect-bounces/route.ts": "qstash-signature",
  "cron/discovery/route.ts": "qstash-signature",
  "cron/follow-up-nudges/route.ts": "qstash-signature",
  "cron/scrape-refresh/route.ts": "qstash-signature",
  "cron/storage-sweep/route.ts": "qstash-signature",
  "cron/sync-bundles/route.ts": "qstash-signature",
  "queue/bundle-sync/route.ts": "qstash-signature",
  // Same wrapper, plus `allowCronBearer` — these two additionally accept
  // Authorization: Bearer $CRON_TRIGGER_SECRET, because the A1 send watcher
  // drives them at ~15s and cannot produce a QStash signature (CAR-215).
  // The credential's blast radius is exactly this pair; see CRON_BEARER_ROUTES.
  "cron/send-follow-ups/route.ts": "qstash-signature+cron-bearer",
  "cron/send-scheduled-emails/route.ts": "qstash-signature+cron-bearer",
  // Apify completion webhook — shared secret via timingSafeEqual (header, CAR-140).
  "apify/run-callback/route.ts": "webhook-secret",
  // One-click unsubscribe — signed HMAC token, intentionally unauthenticated (RFC 8058).
  "notifications/unsubscribe/route.ts": "hmac-token",
  // MCP endpoint — OAuth bearer verified against Supabase JWKS via withMcpAuth.
  "mcp/route.ts": "oauth-jwks",
};

// dot: true — a route.ts inside a dot-directory (the repo already routes
// `.well-known/` elsewhere under src/app) must not fall outside the inventory.
// The brace glob keeps a route authored as .js/.tsx from dodging it either.
const routeFiles = fg
  .sync("**/route.{ts,tsx,js,jsx,mjs}", { cwd: apiDir, dot: true })
  .sort();

const rel = (f: string) => f; // already relative to apiDir
const count = (text: string, re: RegExp) => (text.match(re) || []).length;
// A withApiHandler *call* is `withApiHandler(` or `withApiHandler<Generics>(` — the
// import (`{ withApiHandler }`) is followed by whitespace/brace, so it never matches.
// Counted via String.match (stateless); never RegExp.test on a /g regex (lastIndex trap).
const WRAPPER_CALL = /\bwithApiHandler\s*[<(]/g;
const usesWrapper = (text: string) => count(text, WRAPPER_CALL) > 0;

// Every exported HTTP-method handler on a route. OPTIONS is deliberately excluded:
// it is the CORS preflight (`export async function OPTIONS() { return handleOptions() }`),
// which carries no auth and no data by design, so it needn't be a withApiHandler call.
// Counting the rest lets us assert methodExports === withApiHandler calls, which catches
// a *bare* handler (e.g. `export async function DELETE(){…}`) appended beside a wrapped
// one — invisible to the withApiHandler/requireAdmin counters alone (CAR-140 review).
const HTTP_HANDLER = /\bexport\s+(?:async\s+function|const)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b/g;

describe("route-auth inventory", () => {
  it("finds route files (guards against a broken glob)", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it("wraps EVERY HTTP handler in withApiHandler (or the route is an allowlisted exception)", () => {
    // methodExports === withApiHandler calls means every GET/POST/PUT/PATCH/DELETE/HEAD
    // handler goes through the wrapper. A bare handler (or a fully unwrapped route)
    // makes methodExports exceed wrappers → red. This is what stops an un-authed handler
    // from being appended beside a wrapped one, or a brand-new bare route from shipping.
    const offenders: string[] = [];
    for (const f of routeFiles) {
      if (HAND_ROLLED[rel(f)]) continue;
      const text = readFileSync(path.join(apiDir, f), "utf8");
      const handlers = count(text, HTTP_HANDLER);
      const wrappers = count(text, WRAPPER_CALL);
      if (handlers !== wrappers) {
        offenders.push(`${rel(f)} (httpHandlers=${handlers}, withApiHandler=${wrappers})`);
      }
    }
    expect(
      offenders,
      `these routes have an HTTP handler not wrapped in withApiHandler — wrap it, or add the route to HAND_ROLLED with its mechanism:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("gates EVERY handler under /api/admin/ with requireAdmin (unless machine-token)", () => {
    // Full chain for a session-admin route: methodExports === withApiHandler === requireAdmin.
    // Dropping requireAdmin from any handler makes gated < wrappers; appending a bare
    // handler makes methodExports > wrappers — either turns this red.
    const offenders: string[] = [];
    for (const f of routeFiles) {
      if (!rel(f).startsWith("admin/")) continue;
      if (HAND_ROLLED[rel(f)]) continue; // machine-token admin routes gate differently
      const text = readFileSync(path.join(apiDir, f), "utf8");
      const handlers = count(text, HTTP_HANDLER);
      const wrappers = count(text, WRAPPER_CALL);
      const gated = count(text, /requireAdmin:\s*true/g);
      if (wrappers === 0 || handlers !== wrappers || gated !== wrappers) {
        offenders.push(`${rel(f)} (httpHandlers=${handlers}, withApiHandler=${wrappers}, requireAdmin=${gated})`);
      }
    }
    expect(
      offenders,
      `admin routes with an un-gated or unwrapped handler:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries (each maps to an existing route)", () => {
    const existing = new Set(routeFiles.map(rel));
    const stale = Object.keys(HAND_ROLLED).filter((k) => !existing.has(k));
    expect(stale, `HAND_ROLLED entries with no matching route file: ${stale.join(", ")}`).toEqual([]);
  });

  /**
   * Which routes accept the cron-trigger bearer (CAR-220).
   *
   * `withQStashVerification` used to check `Authorization: Bearer
   * $CRON_TRIGGER_SECRET` at the shared chokepoint with no route scoping, so one
   * secret minted for "run the due-send sweep now" also opened both destructive
   * purges, both paid-Apify routes, the QStash fan-out, the nudge mailer, and
   * the bundle-sync queue — the last of which had its request body bound by the
   * QStash signature until the bearer path stopped requiring one.
   *
   * The wrapper now defaults closed and each route opts in, which moves the
   * blast radius from "whatever imports the wrapper" to this list. That makes it
   * a claim worth pinning: the mechanism label and the source text must agree in
   * both directions, so adding the flag to a third route fails here until
   * someone writes down that it is intended.
   */
  const CRON_BEARER = /\ballowCronBearer\s*:\s*true\b/;
  const CRON_BEARER_ROUTES = Object.entries(HAND_ROLLED)
    .filter(([, mechanism]) => mechanism === "qstash-signature+cron-bearer")
    .map(([route]) => route)
    .sort();

  it("the cron-bearer detector matches an opt-in and nothing else", () => {
    // The two assertions below are only as good as this regex, and a text probe
    // that silently matches nothing would report success. Pinned against the
    // shapes a route can plausibly be written in.
    for (const src of [
      "return withQStashVerification(req, handler, { allowCronBearer: true });",
      "withQStashVerification(\n  req,\n  handler,\n  { allowCronBearer: true },\n)",
      "const OPTS = {allowCronBearer:true};",
    ]) {
      expect(CRON_BEARER.test(src), `should match: ${src}`).toBe(true);
    }
    for (const src of [
      "return withQStashVerification(req, handler);",
      "return withQStashVerification(req, handler, { allowCronBearer: false });",
      "// allowCronBearer is deliberately not passed here",
      "{ allowCronBearerSomeday: true }",
    ]) {
      expect(CRON_BEARER.test(src), `should NOT match: ${src}`).toBe(false);
    }
  });

  it("only the two send routes accept the cron-trigger bearer", () => {
    expect(CRON_BEARER_ROUTES).toEqual([
      "cron/send-follow-ups/route.ts",
      "cron/send-scheduled-emails/route.ts",
    ]);
  });

  it("the cron-bearer label matches the source in both directions", () => {
    const wrong: string[] = [];
    for (const f of routeFiles) {
      const mechanism = HAND_ROLLED[rel(f)];
      const text = readFileSync(path.join(apiDir, f), "utf8");
      const optsIn = CRON_BEARER.test(text);
      const labelled = mechanism === "qstash-signature+cron-bearer";
      if (optsIn && !labelled) {
        wrong.push(
          `${rel(f)} passes allowCronBearer but is labelled "${mechanism ?? "(not hand-rolled)"}" — ` +
            "the cron bearer is a second credential into this route; label it " +
            '"qstash-signature+cron-bearer" and confirm the watcher really needs it',
        );
      }
      if (labelled && !optsIn) {
        wrong.push(
          `${rel(f)} is labelled as accepting the cron bearer but does not pass ` +
            "{ allowCronBearer: true } to withQStashVerification — the A1 watcher will get 401s here",
        );
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("every route the wrapper is used in is inventoried as a qstash mechanism", () => {
    // Anti-vacuity for the pair above: if the wrapper were renamed or a route
    // stopped importing it, the bidirectional check would pass over nothing.
    const users = routeFiles.filter((f) =>
      /\bwithQStashVerification\s*\(/.test(readFileSync(path.join(apiDir, f), "utf8")),
    );
    // Deliberately a literal, not derived from HAND_ROLLED: adding a route
    // should force someone to look at this file and decide whether it belongs
    // on the signature alone or opts into the cron bearer. CAR-217's
    // detect-bounces took it from 9 to 10, and correctly stayed signature-only.
    expect(users.length).toBe(10);
    const mislabelled = users.filter((f) => !(HAND_ROLLED[rel(f)] ?? "").startsWith("qstash-signature"));
    expect(mislabelled, `routes using withQStashVerification without a qstash mechanism label: ${mislabelled.join(", ")}`).toEqual([]);
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

/**
 * CAR-157: the inventory above globs `src/app/api` only, so route handlers living
 * elsewhere under `src/app` were covered by nothing — including
 * `auth/confirm/route.ts`, the one unauthenticated handler in the app that mints a
 * session. They are all legitimately outside the wrapper (none is session-gated),
 * but "legitimate" should be a checked-in claim rather than an omission, so they
 * get the same named-mechanism treatment: a new one fails until it is listed, and
 * a stale entry fails too.
 */
describe("route-auth inventory: handlers outside src/app/api", () => {
  const appDir = path.resolve(here, "../app");

  /**
   * mechanism: how the route authenticates instead of the wrapper.
   * methods: its expected HTTP-method exports (OPTIONS excluded as CORS
   * preflight, matching the main inventory). Pinning the methods is what makes
   * this an inventory rather than a label: without it, appending a bare
   * unauthenticated POST to an already-listed route shipped green — and the
   * listed routes include the one handler in the app that mints a session.
   */
  const OUTSIDE_API: Record<string, { mechanism: string; methods: string[] }> = {
    // Email confirmation link. Verifies a single-use `token_hash` server-side via
    // supabase.auth.verifyOtp, then redirects to a same-origin relative path only.
    // Unauthenticated by nature: it is what establishes the session.
    "auth/confirm/route.ts": { mechanism: "supabase-otp-verify", methods: ["GET"] },
    // RFC 9728 OAuth protected-resource metadata for the MCP endpoint. Public by
    // specification: it is the document clients read *before* they hold a token.
    ".well-known/oauth-protected-resource/route.ts": { mechanism: "public-metadata", methods: ["GET"] },
    ".well-known/oauth-protected-resource/api/mcp/route.ts": { mechanism: "public-metadata", methods: ["GET"] },
  };

  // dot: true is load-bearing — `.well-known/` is a dot-directory, which fast-glob
  // skips by default, and silently missing it would defeat the whole inventory.
  const outsideFiles = fg
    .sync("**/route.{ts,tsx,js,jsx,mjs}", { cwd: appDir, ignore: ["api/**"], dot: true })
    .sort();

  it("inventories every route handler outside src/app/api", () => {
    const unlisted = outsideFiles.filter((f) => !(f in OUTSIDE_API));
    expect(
      unlisted,
      `route handlers outside src/app/api with no inventory entry: ${unlisted.join(", ")}. ` +
        "Add it to OUTSIDE_API with the mechanism it authenticates by, or move it under src/app/api.",
    ).toEqual([]);
  });

  it("has no stale outside-api entries", () => {
    const existing = new Set(outsideFiles);
    const stale = Object.keys(OUTSIDE_API).filter((k) => !existing.has(k));
    expect(stale, `OUTSIDE_API entries with no matching route file: ${stale.join(", ")}`).toEqual([]);
  });

  it("each exposes exactly its pinned HTTP methods and no wrapper", () => {
    // The method pin is the teeth: a NEW handler export on a listed route (say a
    // bare POST beside auth/confirm's GET) fails here instead of shipping as an
    // unnoticed unauthenticated endpoint. If one of these ever needs a user
    // session, it belongs under src/app/api behind withApiHandler, not here.
    const METHOD_EXPORT = /^export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/gm;
    for (const [key, { methods }] of Object.entries(OUTSIDE_API)) {
      const file = path.join(appDir, key);
      // A deleted route is the stale-entries test's failure to own; skip the
      // raw ENOENT here so the report stays legible.
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const exported = [...text.matchAll(METHOD_EXPORT)].map((m) => m[1]).sort();
      expect(exported, `${key} exports unexpected HTTP methods`).toEqual([...methods].sort());
      expect(usesWrapper(text), `${key} now uses withApiHandler; move it under src/app/api`).toBe(false);
    }
  });
});
