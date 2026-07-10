/**
 * One-way "notify the owner" channel (CAR-51).
 *
 * CareerVine has no transactional-email stack — all product email goes out
 * through each user's own Gmail. Owner alerts (e.g. "a user requested AI
 * access") instead go through SendGrid with the same From address the ops
 * healthchecks use. Fail-soft by design: callers must treat a false return as
 * "not delivered" and still persist whatever state they were reporting.
 */

const OWNER_EMAIL = "dawsonlpitcher@gmail.com";
const FROM_EMAIL = "healthcheck@dawsonsprojects.com";
const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

export async function notifyOwner(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn("[admin-notify] SENDGRID_API_KEY not set — skipping owner notification:", subject);
    return false;
  }

  try {
    const res = await fetch(SENDGRID_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: OWNER_EMAIL }] }],
        from: { email: FROM_EMAIL, name: "CareerVine" },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[admin-notify] SendGrid send failed:", res.status, detail);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[admin-notify] SendGrid send errored:", err);
    return false;
  }
}
