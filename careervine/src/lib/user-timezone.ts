/**
 * Server-side resolution of "what timezone is this user actually in?" (CAR-215).
 *
 * Kept out of `lib/timezone.ts` on purpose: that module is imported by
 * `api-client.ts` and must stay free of server-only dependencies. This one
 * touches the database, so it is server-side only.
 *
 * ── Resolution order, and why ────────────────────────────────────────────
 *
 * 1. The `X-CV-Timezone` header on the request in hand. Freshest possible
 *    answer, and for a sequence being created from the browser it is the same
 *    machine the user is looking at. Also covers a brand-new user whose
 *    throttled stamp has not landed yet.
 * 2. `users.timezone` — the stamped value from a previous request.
 * 3. `gmail_connections.calendar_timezone` — what Google Calendar reports.
 *    Third rather than first because it describes the calendar account, and
 *    because until CAR-215 it carried a DEFAULT of America/New_York that made
 *    unsynced rows indistinguishable from genuinely Eastern ones. Post-migration
 *    a non-null value here is real, so it is a fine fallback, just a weaker
 *    signal than the user's live browser.
 * 4. UTC. Deliberately not a US zone: a wrong-but-plausible regional default is
 *    the bug this module exists to end, and UTC reads as "unknown" to anyone
 *    debugging it later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FALLBACK_TIME_ZONE, TIMEZONE_HEADER, coerceTimeZone } from "@/lib/timezone";

/**
 * Best known IANA zone for `userId`.
 *
 * `headers` is optional so MCP and cron callers, which have no browser request,
 * can use the same resolver. Never throws and never returns null: callers are
 * scheduling email and always need something to compute against.
 */
export async function resolveUserTimeZone(
  service: SupabaseClient,
  userId: string,
  headers?: Headers,
): Promise<string> {
  const fromHeader = coerceTimeZone(headers?.get(TIMEZONE_HEADER));
  if (fromHeader) return fromHeader;

  try {
    // error-tolerated: a zone lookup that fails is the same as one that finds
    // nothing, and both fall through to the next source and finally UTC.
    // Throwing here would block scheduling on a transient read.
    const { data: user } = await service
      .from("users")
      .select("timezone")
      .eq("id", userId)
      .maybeSingle();
    const stored = coerceTimeZone(user?.timezone);
    if (stored) return stored;

    // error-tolerated: same as above, and this is already the last source
    // before the UTC fallback.
    const { data: conn } = await service
      .from("gmail_connections")
      .select("calendar_timezone")
      .eq("user_id", userId)
      .maybeSingle();
    const fromCalendar = coerceTimeZone(conn?.calendar_timezone);
    if (fromCalendar) return fromCalendar;
  } catch {
    // A lookup failure must not block scheduling; fall through to UTC.
  }

  return FALLBACK_TIME_ZONE;
}
