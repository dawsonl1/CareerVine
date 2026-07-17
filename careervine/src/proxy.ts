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

export const config = {
  // Run on every route except static assets and API routes. Static assets have
  // no auth state; API routes are route handlers with a writable cookie store,
  // so they refresh and persist their own session and don't need the proxy —
  // skipping them avoids a redundant getUser() round trip per API call.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml|css|js|map|json)$).*)",
  ],
};
