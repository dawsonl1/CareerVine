/**
 * Session-refreshing proxy (Next 16's rename of middleware.ts).
 *
 * The only place in the request lifecycle that can BOTH refresh an expired
 * Supabase access token AND persist the rotated cookies to the browser.
 * Server Components run with a read-only cookie store, so without this,
 * `getUser()` in a layout (e.g. /admin) throws on the cookie write and burns
 * the rotated refresh token — GoTrue reuse detection then revokes the whole
 * session (CAR-141 / R1.1).
 *
 * Canonical @supabase/ssr updateSession pattern: bind a server client to the
 * request/response cookies, call getUser() to force the refresh, and rewrite
 * any rotated cookies onto both the forwarded request (so downstream Server
 * Components see the fresh session) and the response (so the browser does).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/supabase/config";

export async function proxy(request: NextRequest) {
  try {
    const { url, anonKey } = getSupabaseEnv();

    let response = NextResponse.next({ request });

    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          // Write onto the request so Server Components rendered in this same
          // pass read the refreshed session, then rebuild the response from
          // that request and set the cookies on it for the browser.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    // Do not run other logic between client creation and getUser() — the call
    // itself is what refreshes the token and triggers the cookie rewrite.
    await supabase.auth.getUser();

    return response;
  } catch {
    // Never let a session-refresh failure take down the request. This proxy is
    // the first middleware in the app, so an unhandled throw here would 500
    // every matched route at once. Degrade to "not refreshed this pass": every
    // page and route handler still runs its own auth check, so the worst case
    // is one un-refreshed request, not a site-wide outage.
    return NextResponse.next({ request });
  }
}

/**
 * Which requests pay for the refresh above, and why the rest do not.
 *
 * getUser() is a REMOTE GoTrue call, not a local JWT decode, so every matched
 * request spends a full network round trip before Next renders a byte. Three
 * classes of request are excluded because they provably cannot need it:
 *
 *  • Static assets — no auth state at all.
 *  • API routes — route handlers own a WRITABLE cookie store, so they refresh
 *    and persist their own session. Matching them would be a redundant
 *    getUser() per API call.
 *  • Public routes (CAR-229) — every path `isPublicPath` in
 *    `lib/public-routes.ts` calls true. The proxy exists for ONE failure: a
 *    Server Component that reads the session cannot write the rotated cookies
 *    back (CAR-141). No public route has one. `/` `/privacy` `/terms`
 *    `/reset-password` `/contacts/preview` `/oauth/consent` are client
 *    components or static text, `/auth` renders the sign-in form, and
 *    `/auth/confirm` is a route handler that mints its own session with a
 *    writable store. A signed-in visitor landing on `/` still refreshes:
 *    `createBrowserClient` rotates and persists the token itself.
 *
 * The public list is duplicated here because Next requires `matcher` to be a
 * statically analyzable literal — a variable or function call is ignored at
 * build time. `src/__tests__/proxy-matcher.test.ts` compiles this matcher the
 * way `next build` does and asserts it agrees with `isPublicPath` across the
 * whole route inventory, so the copy cannot drift from the source of truth.
 *
 * Alternatives are anchored (`terms$`, or `.` for the `.rsc`/`.json` transport
 * forms of the same route) so a FUTURE route that merely starts with a public
 * route's name — `/authors`, `/terms-of-sale` — keeps its session refresh
 * instead of silently losing it.
 */
export const config = {
  matcher: [
    "/((?!$|api|_next/static|_next/image|favicon.ico|privacy(?:$|\\.)|terms(?:$|\\.)|reset-password(?:$|\\.)|contacts/preview(?:$|\\.)|auth(?:$|[./])|oauth(?:$|[./])|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml|css|js|map|json)$).*)",
  ],
};
