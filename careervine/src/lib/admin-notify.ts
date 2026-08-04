/**
 * One-way "notify the owner" channel (CAR-51).
 *
 * CareerVine has no transactional-email stack — all product email goes out
 * through each user's own Gmail. Owner alerts (e.g. "a user requested AI
 * access", "the send watcher has gone quiet") go out through Resend instead.
 * Fail-soft by design: callers must treat a false return as "not delivered" and
 * still persist whatever state they were reporting.
 *
 * ── Was SendGrid, and had been silently dead since 2026-07-10 ───────────
 *
 * The SendGrid free trial expired: the account sits at 0 credits and refuses
 * every send with `451 Maximum credits exceeded`. Because this helper is
 * fail-soft, nothing surfaced — owner alerts have simply not arrived since.
 * CAR-215 needed a working owner alert (a dead send watcher has to reach a
 * human), so the helper moved to Resend rather than building a second channel
 * beside a broken one. Every caller is fixed by this one change.
 *
 * From address uses careervine.app, the verified Resend domain, rather than the
 * shared resend.dev sender: better deliverability into Gmail, which is where
 * these land.
 */

const OWNER_EMAIL = "dawsonlpitcher@gmail.com";
const FROM_EMAIL = "CareerVine Alerts <alerts@careervine.app>";
const RESEND_SEND_URL = "https://api.resend.com/emails";

export async function notifyOwner(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[admin-notify] RESEND_API_KEY not set — owner notification DROPPED:", subject);
    return false;
  }

  try {
    const res = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [OWNER_EMAIL],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[admin-notify] Resend send failed:", res.status, detail);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[admin-notify] Resend send errored:", err);
    return false;
  }
}
