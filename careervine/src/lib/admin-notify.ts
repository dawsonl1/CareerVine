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

/**
 * Hard ceiling on the Resend round trip (CAR-220).
 *
 * Callers await this inside serverless functions with a 60s `maxDuration`, and
 * `checkWatcherHealth` awaits it on the hourly send-scheduled-emails path —
 * the path that IS delivery whenever the alert has something to report. With no
 * signal, undici will wait ~300s, so a hung Resend would blow the function
 * budget and take that hour's sweep down with it; the platform kill is not
 * catchable, so no amount of care downstream recovers it.
 *
 * 5s is roughly an order of magnitude above a normal Resend response and still
 * under a tenth of the budget. Missing the alert costs one delayed email to
 * one person, and it is retried on the next tick because a timeout returns
 * false and the caller therefore does not stamp its cooldown.
 */
const RESEND_TIMEOUT_MS = 5_000;

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
      // Covers the response body read below as well as the request itself:
      // aborting the fetch aborts the body stream it returned.
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[admin-notify] Resend send failed:", res.status, detail);
      return false;
    }
    return true;
  } catch (err) {
    // A timeout is not an ordinary send error — it is the caller's budget being
    // spent — so it says so, and names the alert that was dropped.
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (aborted) {
      console.error(
        `[admin-notify] Resend send timed out after ${RESEND_TIMEOUT_MS}ms — owner notification DROPPED:`,
        subject,
      );
    } else {
      console.error("[admin-notify] Resend send errored:", err);
    }
    return false;
  }
}
