/**
 * Delivery side of the bounce alert (CAR-217): preference check, recipient
 * lookup, unsubscribe token, send. The rendering half is `./bounce-alert`.
 *
 * ORDERING, stated because it is a real trade rather than an oversight: the
 * caller marks `bounced_at` and cancels the queued sends BEFORE calling this.
 * Cancelling is the part that must never be lost, and it is also what makes the
 * detection idempotent, so it goes first. The cost is that a Resend outage means
 * the address is retired without the user being told, and the next pass will not
 * re-notify because the null -> bounced transition has already happened. That is
 * the right way round: silently cancelling is recoverable (the flag is on the
 * contact page and the compose modal), silently CONTINUING to send at a dead
 * address is not.
 *
 * Nothing here throws. A notification failure must not unwind bounce handling
 * that already succeeded, so every path returns an outcome instead.
 */

import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendAppEmail } from "@/lib/notify/email";
import { signUnsubscribeToken } from "@/lib/notify/tokens";
import { renderBounceAlert, type BounceAlertItem } from "@/lib/notify/bounce-alert";

export type BounceAlertOutcome =
  | "sent"
  | "no_items"
  | "opted_out"
  | "no_recipient"
  | "send_failed"
  | "error";

/**
 * Stable across at-least-once retries of the same discovery, distinct across
 * genuinely new ones: user + the sorted address set + the UTC day. The addresses
 * are sorted so detection order cannot change the key.
 */
export function bounceAlertIdempotencyKey(
  userId: string,
  addresses: string[],
  nowIso: string,
): string {
  const day = nowIso.slice(0, 10);
  return `bounce-${userId}-${day}-${[...addresses].sort().join(",")}`;
}

export async function sendBounceAlert(
  userId: string,
  items: BounceAlertItem[],
  deps: { nowIso?: string } = {},
): Promise<BounceAlertOutcome> {
  if (items.length === 0) return "no_items";

  try {
    const service = createSupabaseServiceClient();
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.careervine.app").replace(/\/$/, "");

    // Opt-out check. A read error must NOT be treated as "enabled": defaulting
    // to send on a broken read is how an opted-out user gets mail they refused.
    // A missing row is a different case and does default to enabled, since the
    // column is NOT NULL DEFAULT true and only a deleted user has no row.
    const { data: profile, error: profileError } = await service
      .from("users")
      .select("bounce_alerts_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) {
      console.error(`[bounce-alert] preference read failed for ${userId}:`, profileError);
      return "error";
    }
    if (profile && (profile as { bounce_alerts_enabled?: boolean | null }).bounce_alerts_enabled === false) {
      return "opted_out";
    }

    const { data: authData, error: authError } = await service.auth.admin.getUserById(userId);
    const to = authData?.user?.email;
    if (authError || !to) {
      console.error(`[bounce-alert] no recipient address for ${userId}:`, authError);
      return "no_recipient";
    }

    const token = signUnsubscribeToken(userId, "bounce_alerts");
    const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
    const { subject, html, text } = renderBounceAlert(items, appUrl, unsubscribeUrl);

    const nowIso = deps.nowIso ?? new Date().toISOString();
    const res = await sendAppEmail({
      to,
      subject,
      html,
      text,
      listUnsubscribeUrl: unsubscribeUrl,
      idempotencyKey: bounceAlertIdempotencyKey(userId, items.map((i) => i.address), nowIso),
    });

    if (!res.ok) {
      console.error(`[bounce-alert] send failed for ${userId}: ${res.error}`);
      return "send_failed";
    }
    return "sent";
  } catch (err) {
    console.error(`[bounce-alert] threw for ${userId}:`, err);
    return "error";
  }
}
