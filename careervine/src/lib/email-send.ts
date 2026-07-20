/**
 * Shared tracked-send path (plan 26).
 *
 * EVERY outbound email flows through sendTrackedEmail() so send policy can't
 * drift between surfaces. Its callers: the app's /api/gmail/send route, the MCP
 * server's send_email tool, the scheduled-email cron (processScheduledEmails),
 * the follow-up cron (/api/cron/send-follow-ups), and the interactive follow-up
 * confirm route (/api/gmail/follow-ups/confirm). The crons are NOT exempt from
 * the cap: they call sendTrackedEmail() like the interactive paths and catch
 * SendPolicyError to DEFER rather than bypass. A 429 (daily cap reached) stops
 * that cron tick and retries next run; a 422 (recipient has bounced) is left
 * for the bounce path to resolve (detectBounces cancels the sequence once the
 * NDR lands), except a follow-up message already past its 3-day retry window,
 * which the follow-up cron cancels outright. sendTrackedEmail() applies:
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
import { sendEmail, getConnection, type ComposeEmailOptions } from "@/lib/gmail-send-core";
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
      `Daily send limit reached (${DAILY_SEND_CAP}). Sending more today risks Gmail deliverability. Try again tomorrow.`,
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
      `${toAddr} has bounced before, so sending again would hurt deliverability. Verify or update the address first.`,
      422,
    );
  }
  if (matchedRow?.source === "pattern_guessed") {
    warnings.push(
      `${toAddr} is a pattern-guessed address that has never been verified, so it may bounce.`,
    );
  }
  const matchedContactId = matchedRow?.contact_id ?? null;

  const result = await sendEmail(userId, { ...opts, bodyHtml: opts.bodyHtml || "" });

  // Immediately cache the sent message metadata so it shows up without a full sync.
  const conn = await getConnection(userId);
  const sentAt = new Date().toISOString();

  const { data: sentRow, error: cacheError } = await service.from("email_messages").upsert(
    {
      user_id: userId,
      gmail_message_id: result.messageId,
      thread_id: result.threadId || null,
      subject: opts.subject,
      snippet: opts.bodyHtml ? opts.bodyHtml.replace(/<[^>]*>/g, "").slice(0, 200) : null,
      // Persist the full body so free-tier Outreach can re-read the sent message
      // without a live Gmail fetch (CAR-115). Every outbound path — interactive
      // send, MCP send_email, scheduled-email cron, follow-up cron — flows through
      // here, so this one write-site covers them all.
      body_html: opts.bodyHtml || null,
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
  ).select("id").single();
  if (cacheError) console.error("Failed to cache sent message:", cacheError);

  // Multi-contact attribution (CAR-159): the provenance query above returns
  // EVERY contact whose contact_emails row matches the recipient address —
  // matched_contact_id keeps only the first as the denormalized primary, the
  // junction links them all so the sent message appears on each timeline.
  const matchedContactIds = [
    ...new Set(
      (emailRows ?? [])
        .map((r: { contact_id: number | null }) => r.contact_id)
        .filter((id): id is number => id != null)
    ),
  ];
  if (sentRow && matchedContactIds.length > 0) {
    const { error: linkError } = await service.from("email_message_contacts").upsert(
      matchedContactIds.map((cid) => ({ email_message_id: (sentRow as { id: number }).id, contact_id: cid })),
      { onConflict: "email_message_id,contact_id", ignoreDuplicates: true }
    );
    if (linkError) console.error("Failed to link sent message to contacts:", linkError);
  }

  // Record an interaction so each matched contact's last_touch is updated and
  // they don't immediately reappear as a "Reach Out" suggestion (CAR-159: an
  // address shared by two contacts touched both).
  if (matchedContactIds.length > 0) {
    await service.from("interactions").insert(
      matchedContactIds.map((cid) => ({
        contact_id: cid,
        interaction_date: sentAt,
        interaction_type: "email",
        summary: `Sent: ${opts.subject}`,
      }))
    ).then(null, (err: unknown) => console.error("Failed to create email interaction:", err));
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
