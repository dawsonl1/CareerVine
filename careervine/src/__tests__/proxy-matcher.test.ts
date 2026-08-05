/**
 * The proxy matcher must run on exactly the authenticated routes (CAR-229).
 *
 * `src/proxy.ts` spends a REMOTE GoTrue round trip (`auth.getUser()`) before
 * Next renders anything on every matched request, so which requests it matches
 * is a performance decision AND a correctness one:
 *
 *  • matching a public route buys nothing — none of them has a Server Component
 *    that reads the session, which is the single failure the proxy exists to
 *    prevent (CAR-141) — and taxes the landing page, the sign-in page and the
 *    OAuth consent screen with a network hop each;
 *  • MISSING an authenticated route silently breaks session refresh there, and
 *    the symptom (a burnt refresh token, a revoked session) surfaces nowhere
 *    near the regex that caused it.
 *
 * `lib/public-routes.ts` is the single source of truth for which paths are
 * public. Next requires `config.matcher` to be a statically analyzable literal,
 * so the list is necessarily duplicated in the regex; this file is the guard
 * that keeps the copy honest. The route inventory is globbed from `src/app`
 * rather than hand-listed, so a NEW page is covered the day it lands instead of
 * the day someone remembers to add it here.
 *
 * The matcher is compiled the way `next build` compiles it — through Next's own
 * `getMiddlewareMatchers` + `getMiddlewareRouteMatcher` — rather than through a
 * hand-rolled `new RegExp`. Next wraps the source with an optional
 * `/_next/data/...` prefix and a `.rsc` / `.json` transport suffix before it
 * ever becomes a regex, and a local approximation would silently disagree about
 * exactly the transport forms a soft navigation uses. If a Next upgrade moves
 * these internals this file fails loudly, which is the correct trade against a
 * guard that quietly stops describing production.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { config } from "@/proxy";
import { isPublicPath } from "@/lib/public-routes";

// createRequire rather than an import: these are internal CJS modules Next
// ships no declarations for, so a static import cannot resolve a type and a
// bare require() is banned by lint.
const requireCjs = createRequire(import.meta.url);
const { getMiddlewareMatchers } = requireCjs("next/dist/build/analysis/get-page-static-info");
const { getMiddlewareRouteMatcher } = requireCjs(
  "next/dist/shared/lib/router/utils/middleware-route-matcher",
);

/** True when the proxy would run for `pathname`, per `next build`'s compilation. */
const runsProxy = (() => {
  const compiled = getMiddlewareMatchers(config.matcher, {});
  const match = getMiddlewareRouteMatcher(compiled);
  return (pathname: string) => Boolean(match(pathname, { headers: {} }, {}));
})();

const APP_DIR = path.join(process.cwd(), "src", "app");

/**
 * Every routable page URL under src/app, with dynamic segments filled in.
 *
 * Route handlers under src/app/api are excluded on purpose: the matcher skips
 * `/api` wholesale because a route handler owns a writable cookie store.
 */
function routeInventory(dir = APP_DIR, prefix = ""): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "page.tsx") routes.push(prefix || "/");
    if (!entry.isDirectory()) continue;
    // Route groups and private folders never appear in a URL; api and
    // .well-known are route handlers, not pages.
    if (entry.name === "api" || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const segment = entry.name.startsWith("[") ? "123" : entry.name;
    routes.push(...routeInventory(path.join(dir, entry.name), `${prefix}/${segment}`));
  }
  return routes;
}

describe("proxy matcher (CAR-229)", () => {
  const routes = routeInventory();

  it("finds the app's page routes (guards against an empty inventory)", () => {
    // A broken glob would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain("/");
    expect(routes).toContain("/contacts/123");
  });

  it("runs on an authenticated route and skips a public one, for every page in src/app", () => {
    const disagreements = routes.filter((route) => runsProxy(route) === isPublicPath(route));
    expect(disagreements).toEqual([]);
  });

  it("skips the public routes the shell tax was costing", () => {
    for (const route of ["/", "/privacy", "/terms", "/auth", "/reset-password", "/contacts/preview"]) {
      expect(isPublicPath(route)).toBe(true);
      expect(runsProxy(route)).toBe(false);
    }
  });

  it("skips public prefixes, including the sign-in and OAuth consent surfaces", () => {
    // /auth/confirm is a route handler that mints its own session with a
    // writable cookie store; /oauth/consent renders an inline sign-in form.
    for (const route of ["/auth/confirm", "/oauth", "/oauth/consent"]) {
      expect(isPublicPath(route)).toBe(true);
      expect(runsProxy(route)).toBe(false);
    }
  });

  it("still runs on the authenticated routes, including the transport form of a soft navigation", () => {
    for (const route of [
      "/contacts",
      "/contacts.rsc",
      "/contacts/123",
      "/settings",
      "/inbox",
      "/outreach",
      "/admin",
      "/admin/users/123",
      "/onboarding/connected",
    ]) {
      expect(runsProxy(route)).toBe(true);
    }
  });

  it("skips the transport forms of a public route too", () => {
    for (const route of ["/privacy.rsc", "/terms.rsc", "/auth.rsc", "/contacts/preview.rsc"]) {
      expect(runsProxy(route)).toBe(false);
    }
  });

  it("does not swallow a future route that merely starts with a public one's name", () => {
    // The exclusions are anchored, so `/authors` is not `/auth` and
    // `/terms-of-sale` is not `/terms`. An unanchored alternative would strip
    // session refresh from a route nobody has written yet, with no test to say so.
    for (const route of ["/authors", "/oauthful", "/terms-of-sale", "/privacy-settings", "/reset-passwords"]) {
      expect(isPublicPath(route)).toBe(false);
      expect(runsProxy(route)).toBe(true);
    }
  });

  it("keeps skipping API routes and static assets", () => {
    for (const route of [
      "/api/contacts",
      "/api/gmail/connection",
      "/_next/static/chunk.js",
      "/_next/image",
      "/favicon.ico",
      "/icon.png",
      "/robots.txt",
    ]) {
      expect(runsProxy(route)).toBe(false);
    }
  });
});
