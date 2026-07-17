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
}

export const config = {
  // Run on every route except static assets — auth state is irrelevant there
  // and skipping them keeps the refresh off the hot path for images/chunks.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
