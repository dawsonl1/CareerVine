import { getConnection } from "@/lib/gmail-send-core";
import { syncEmailsForContact } from "@/lib/gmail";
import { resolveCapabilities } from "@/lib/capabilities/resolve";

/**
 * CAR-109: when a contact is added or updated with an email address, pull that
 * person's Gmail history so messages you exchanged BEFORE they were a contact
 * appear on their profile timeline.
 *
 * This is the piece the existing `backfillEmailsForContact` cannot do:
 * backfill only re-links already-cached rows with a null `matched_contact_id`,
 * but correspondence with someone who was never a contact was never fetched at
 * all, so there is nothing to re-link. This function actually fetches it.
 *
 * **Paid tier only.** Free-tier connections request only `gmail.send` and hold
 * no `mailbox:read` scope (CAR-102), so their inbox is unreadable and there is
 * nothing to fetch — this returns early for them. Only accounts with the
 * `mailbox:read` capability trigger a live fetch.
 *
 * Best-effort: callers should not let a failure fail the import (wrap in try/catch).
 *
 * @returns messages synced, or 0 when skipped (no emails, free tier, or Gmail
 *          not connected).
 */
export async function syncContactEmailHistoryIfPaid(
  userId: string,
  contactId: number,
  contactEmails: string[],
): Promise<number> {
  if (contactEmails.length === 0) return 0;

  // Paid-tier gate: only accounts with inbox read scope can fetch history.
  const caps = await resolveCapabilities(userId);
  if (!caps.has("mailbox:read")) return 0;

  const conn = await getConnection(userId);
  if (!conn) return 0; // Gmail not connected — nothing to fetch from.

  return syncEmailsForContact(userId, contactId, contactEmails, conn.gmail_address, 90);
}
