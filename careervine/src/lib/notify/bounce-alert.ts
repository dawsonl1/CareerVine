/**
 * The bounce alert email (CAR-217).
 *
 * Sent when detection finds an address that has permanently stopped accepting
 * mail. It is the ONLY signal the user gets: the queued sends are cancelled
 * silently in the background, and without this email a follow-up sequence would
 * simply stop with no explanation. So the copy has to say all three things,
 * plainly: what died, what CareerVine already did about it, and what is left for
 * the user to do.
 *
 * One email per detection pass, not per address, because a pass that runs after
 * a long gap can find several at once and three separate emails about the same
 * discovery reads as a malfunction.
 *
 * Kept pure (no I/O) so copy and escaping are unit-testable on their own, the
 * same split `follow-up-nudges/digest.ts` uses.
 *
 * Copy rule: no em dashes anywhere a user reads (rule 35).
 */

export interface BounceAlertItem {
  contactName: string;
  address: string;
  /** Contact page target. Null when the address matched no contact row. */
  contactId: number | null;
  /** Follow-up sequences retired for this address in the same pass. */
  cancelledFollowUps: number;
  /** Queued scheduled emails cancelled for this address in the same pass. */
  cancelledScheduled: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * "2 follow-ups and 1 scheduled email", omitting whichever half is zero and
 * returning "" when nothing was queued, so the caller can drop the clause
 * entirely rather than print "cancelled 0 things".
 */
export function describeCancellations(followUps: number, scheduled: number): string {
  const parts: string[] = [];
  if (followUps > 0) parts.push(`${followUps} follow-up${followUps === 1 ? "" : "s"}`);
  if (scheduled > 0) parts.push(`${scheduled} scheduled email${scheduled === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

export function renderBounceAlert(
  items: BounceAlertItem[],
  appUrl: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const single = items.length === 1;
  const subject = single
    ? `Your email to ${items[0].contactName} could not be delivered`
    : `${items.length} contact addresses stopped accepting mail`;

  const intro = single
    ? "The address below rejected your message permanently, so anything still queued to it has been cancelled. Nothing more will be sent to it until you update the address."
    : "The addresses below rejected your messages permanently, so anything still queued to them has been cancelled. Nothing more will be sent to them until you update the addresses.";

  const linkFor = (item: BounceAlertItem) =>
    item.contactId != null ? `${appUrl}/contacts/${item.contactId}` : `${appUrl}/contacts`;

  const rows = items
    .map((item, i) => {
      const border = i < items.length - 1 ? "border-bottom:1px solid #f1f2f4;" : "";
      const cancelled = describeCancellations(item.cancelledFollowUps, item.cancelledScheduled);
      const cancelledLine = cancelled
        ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">Cancelled ${escapeHtml(cancelled)}.</div>`
        : "";
      return `<div style="padding:12px 16px;${border}">
        <div style="font-size:14px;font-weight:600;color:#1a1a1a;">${escapeHtml(item.contactName)}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">${escapeHtml(item.address)}</div>
        ${cancelledLine}
      </div>`;
    })
    .join("");

  const ctaUrl = single ? linkFor(items[0]) : `${appUrl}/contacts`;
  const ctaLabel = single ? "Update this contact" : "Review these contacts";

  const html = `<div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <div style="padding:28px 32px 4px;">
      <div style="font-size:18px;font-weight:700;color:#2f6f4f;">CareerVine</div>
    </div>
    <div style="padding:4px 32px 24px;color:#1a1a1a;">
      <h1 style="font-size:20px;line-height:1.35;margin:12px 0 8px;">${escapeHtml(subject)}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#444444;">${escapeHtml(intro)}</p>
      <div style="border:1px solid #eceef1;border-radius:12px;overflow:hidden;margin:0 0 20px;">${rows}</div>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#444444;">Bounced addresses are usually stale, so the fix is normally a corrected address on the contact. Continuing to send to one hurts how the rest of your mail is delivered, which is why sending is blocked until you change it.</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:15px;font-weight:600;">${escapeHtml(ctaLabel)}</a>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eceef1;background:#fafbfc;">
      <p style="font-size:12px;line-height:1.5;color:#8a8f98;margin:0;">You are receiving this because an email you sent through CareerVine could not be delivered. <a href="${unsubscribeUrl}" style="color:#8a8f98;text-decoration:underline;">Turn off bounce alerts</a>, or manage email settings in your account.</p>
    </div>
  </div>
</div>`;

  const textRows = items.map((item) => {
    const cancelled = describeCancellations(item.cancelledFollowUps, item.cancelledScheduled);
    return `- ${item.contactName} (${item.address})${cancelled ? `. Cancelled ${cancelled}.` : ""}`;
  });

  const text = [
    `${subject}.`,
    "",
    intro,
    "",
    ...textRows,
    "",
    "Bounced addresses are usually stale, so the fix is normally a corrected address on the contact. Continuing to send to one hurts how the rest of your mail is delivered, which is why sending is blocked until you change it.",
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    `Turn off bounce alerts: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
}
