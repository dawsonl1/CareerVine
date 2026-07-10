/**
 * Shared tracked-send path (plan 26).
 *
 * Interactive sends — the app's /api/gmail/send route and the MCP server's
 * send_email tool — flow through sendTrackedEmail() so send policy can't
 * drift between those surfaces. (Cron-driven deliveries — scheduled emails
 * and follow-up sequences — call sendEmail() directly and are NOT counted
 * against the daily cap or interaction-logged; recipient bounce is enforced
 * at schedule/sequence creation time instead.) sendTrackedEmail() applies:
 *   - daily cap (deliverability guardrail)
 *   - bounced-address refusal
 *   - pattern-guessed-address warning
 *   - sent-message caching + interaction logging
 *   - NO tier auto-graduation: an outbound cold email isn't a
 *     relationship yet. Graduation happens on their reply (gmail sync /
 *     follow-up reply detection), a manually logged interaction, or a
 *     meeting link.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getConnection, type ComposeEmailOptions } from "@/lib/gmail";
import { EmailDirection, GmailLabel } from "@/lib/constants";
import { trackServer, checkCompaniesEmailedMilestone } from "@/lib/analytics/server";

/**
 * Daily outbound cap (plan 24 Phase 4). Consumer Gmail allows ~500/day,
 * but bursts anywhere near that torch sender reputation for cold
 * outreach — stay far below it.
 */
export const DAILY_SEND_CAP = 100;

/** Policy violation (cap, bounce) — carries an HTTP-ish status for the route wrapper. */
export class SendPolicyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SendPolicyError";
    this.status = status;
  }
}

export interface TrackedSendResult {
  messageId: string;
  threadId: string;
  matchedContactId: number | null;
  /** How many sends remain in today's cap after this one. */
  capRemaining: number;
  /** Non-fatal policy notes (e.g. pattern-guessed recipient address). */
  warnings: string[];
}

export async function sendTrackedEmail(
  userId: string,
  opts: ComposeEmailOptions,
  /** Analytics context the transport layer can't infer (CAR-38). */
  analytics?: { aiAssisted?: boolean; isScheduled?: boolean; isFollowUp?: boolean }
): Promise<TrackedSendResult> {
  const service = createSupabaseServiceClient();
  const toAddr = opts.to.trim().toLowerCase();
  const warnings: string[] = [];

  // Send-limit guardrail
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const { count: sentToday } = await service
    .from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("direction", EmailDirection.Outbound)
    .eq("is_simulated", false)
    .gte("date", midnight.toISOString());
  if ((sentToday ?? 0) >= DAILY_SEND_CAP) {
    await trackServer(userId, "send_cap_hit", {});
    throw new SendPolicyError(
      `Daily send limit reached (${DAILY_SEND_CAP}). Sending more today risks Gmail deliverability — try again tomorrow.`,
      429,
    );
  }

  // Recipient provenance: refuse bounced addresses, warn on pattern-guessed.
  // One query also yields the contact match used for caching/logging below.
  const { data: emailRows } = await service
    .from("contact_emails")
    .select("contact_id, source, bounced_at, contacts!inner(user_id)")
    .eq("email", toAddr)
    .eq("contacts.user_id", userId);
  const matchedRow = (emailRows ?? [])[0] as
    | { contact_id: number; source: string; bounced_at: string | null }
    | undefined;
  if ((emailRows ?? []).some((r: { bounced_at: string | null }) => r.bounced_at != null)) {
    throw new SendPolicyError(
      `${toAddr} has bounced before — sending again would hurt deliverability. Verify or update the address first.`,
      422,
    );
  }
  if (matchedRow?.source === "pattern_guessed") {
    warnings.push(
      `${toAddr} is a pattern-guessed address that has never been verified — it may bounce.`,
    );
  }
  const matchedContactId = matchedRow?.contact_id ?? null;

  const result = await sendEmail(userId, { ...opts, bodyHtml: opts.bodyHtml || "" });

  // Immediately cache the sent message metadata so it shows up without a full sync.
  const conn = await getConnection(userId);
  const sentAt = new Date().toISOString();

  await service.from("email_messages").upsert(
    {
      user_id: userId,
      gmail_message_id: result.messageId,
      thread_id: result.threadId || null,
      subject: opts.subject,
      snippet: opts.bodyHtml ? opts.bodyHtml.replace(/<[^>]*>/g, "").slice(0, 200) : null,
      from_address: conn?.gmail_address?.toLowerCase() || "",
      to_addresses: [toAddr],
      date: sentAt,
      label_ids: [GmailLabel.Sent],
      is_read: true,
      direction: EmailDirection.Outbound,
      matched_contact_id: matchedContactId,
      ai_assisted: analytics?.aiAssisted ?? false,
    },
    { onConflict: "user_id,gmail_message_id", ignoreDuplicates: false }
  );

  // Record an interaction so the contact's last_touch is updated and they
  // don't immediately reappear as a "Reach Out" suggestion.
  if (matchedContactId) {
    await service.from("interactions").insert({
      contact_id: matchedContactId,
      interaction_date: sentAt,
      interaction_type: "email",
      summary: `Sent: ${opts.subject}`,
    }).then(null, (err: unknown) => console.error("Failed to create email interaction:", err));
  }

  await trackServer(userId, "email_sent", {
    is_follow_up: analytics?.isFollowUp ?? false,
    is_scheduled: analytics?.isScheduled ?? false,
    ai_assisted: analytics?.aiAssisted ?? false,
  });
  await checkCompaniesEmailedMilestone(userId);

  return {
    messageId: result.messageId,
    threadId: result.threadId,
    matchedContactId,
    capRemaining: DAILY_SEND_CAP - (sentToday ?? 0) - 1,
    warnings,
  };
}
