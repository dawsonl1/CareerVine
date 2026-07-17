/**
 * The follow-up reminder digest email (CAR-105).
 *
 * One stage-agnostic template per user per run: the cadence engine already
 * decides WHICH items are due (day 0 / 4 / 9), so the email just says "these N
 * are awaiting your review" without leaking the milestone. Kept pure (no I/O)
 * so the copy and escaping are unit-testable on their own.
 *
 * Copy rule: no em dashes anywhere a user reads (rule 35).
 */

export interface NudgeItem {
  contactName: string;
  subject: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderNudgeDigest(
  items: NudgeItem[],
  appUrl: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const n = items.length;
  const heading =
    n === 1
      ? "You have a follow-up awaiting your review"
      : `You have ${n} follow-ups awaiting your review`;
  // The follow-up review UI (Send now / They replied) lives at /inbox via
  // EmailExperience (OutreachShell for free tier; the Follow-ups tab for
  // premium). /outreach is the separate company-stepping queue and shows none
  // of these messages, so the CTA must target /inbox (CAR-139 review fix).
  const portalUrl = `${appUrl}/inbox`;

  const rows = items
    .map((it, i) => {
      const border = i < items.length - 1 ? "border-bottom:1px solid #f1f2f4;" : "";
      return `<div style="padding:12px 16px;${border}">
        <div style="font-size:14px;font-weight:600;color:#1a1a1a;">${escapeHtml(it.contactName)}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">${escapeHtml(it.subject)}</div>
      </div>`;
    })
    .join("");

  const html = `<div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <div style="padding:28px 32px 4px;">
      <div style="font-size:18px;font-weight:700;color:#2f6f4f;">CareerVine</div>
    </div>
    <div style="padding:4px 32px 24px;color:#1a1a1a;">
      <h1 style="font-size:20px;line-height:1.35;margin:12px 0 8px;">${escapeHtml(heading)}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#444444;">Confirm the ones you want to send, or mark the ones that already replied. They stay ready for you until you act on them.</p>
      <div style="border:1px solid #eceef1;border-radius:12px;overflow:hidden;margin:0 0 24px;">${rows}</div>
      <a href="${portalUrl}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:15px;font-weight:600;">Review follow-ups</a>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eceef1;background:#fafbfc;">
      <p style="font-size:12px;line-height:1.5;color:#8a8f98;margin:0;">You are receiving this because you have follow-ups awaiting review in CareerVine. <a href="${unsubscribeUrl}" style="color:#8a8f98;text-decoration:underline;">Unsubscribe from these reminders</a>, or manage email settings in your account.</p>
    </div>
  </div>
</div>`;

  const textLines = items.map((it) => `- ${it.contactName}: ${it.subject}`);
  const text = [
    heading + ".",
    "",
    "Confirm the ones you want to send, or mark the ones that already replied. They stay ready for you until you act on them.",
    "",
    ...textLines,
    "",
    `Review follow-ups: ${portalUrl}`,
    "",
    `Unsubscribe from these reminders: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject: heading, html, text };
}
