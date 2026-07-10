/**
 * Email confirm-link landing — the branded verification email's target.
 *
 * Verifies the `token_hash` server-side (canonical @supabase/ssr pattern),
 * which both confirms the email and mints a real session in cookies, so the
 * user is signed in the moment they click — even in a fresh tab or on a
 * different device, where the PKCE code-exchange flow can't work (no code
 * verifier outside the signup tab; see CAR-52).
 *
 * Handles every email OTP type so password recovery can share it via
 * `?next=/reset-password`. Invalid/expired links bounce to the sign-in
 * screen with a friendly notice.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { trackServer } from "@/lib/analytics/server";

const OTP_TYPES: readonly string[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

/**
 * Only same-origin relative paths may be redirect targets — absolute URLs
 * and protocol-relative (`//evil.com`) values fall back to the dashboard.
 */
function sanitizeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = sanitizeNext(searchParams.get("next"));

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });

    if (!error) {
      if (type === "signup") {
        // Await so the serverless flush isn't cut off by the redirect.
        await trackServer(data.user?.id, "user_email_verified", {});
      }
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  // Expired, already-used (e.g. an email scanner prefetched it), or malformed
  // link — send them to sign-in with context instead of a dead end.
  return NextResponse.redirect(new URL("/auth?error=confirm-expired", request.url));
}
