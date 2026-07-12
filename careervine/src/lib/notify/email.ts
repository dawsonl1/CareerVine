/**
 * App→user transactional email via Resend (CAR-105).
 *
 * This is the app's FIRST outbound-to-user email path. It is DISTINCT from
 * `sendTrackedEmail` (which sends the user's OWN Gmail to their contacts, counts
 * against their daily cap, and logs an interaction). These emails come FROM the
 * CareerVine identity on the verified careervine.app Resend domain and go TO the
 * user. Keep this generic: nudges are its first use, but receipts / digests /
 * upgrade prompts will reuse it.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "CareerVine <notifications@careervine.app>";

export interface AppEmail {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text alternative (improves deliverability). */
  text?: string;
  /** When set, adds RFC 8058 List-Unsubscribe + one-click List-Unsubscribe-Post. */
  listUnsubscribeUrl?: string;
  /** Resend idempotency key — dedupes retries of the same logical send. */
  idempotencyKey?: string;
}

export interface AppEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Send one transactional email. Returns `{ ok: false }` rather than throwing so a
 * cron digest loop can record per-recipient failures and keep going. Requires
 * RESEND_API_KEY in the environment (Vercel).
 */
export async function sendAppEmail(email: AppEmail): Promise<AppEmailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("[notify] RESEND_API_KEY missing — cannot send app email");
    return { ok: false, error: "missing_api_key" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey;

  const body: Record<string, unknown> = {
    from: FROM,
    to: [email.to],
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;
  if (email.listUnsubscribeUrl) {
    body.headers = {
      "List-Unsubscribe": `<${email.listUnsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[notify] Resend send failed (${res.status}): ${detail}`);
      return { ok: false, error: `resend_${res.status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch (err) {
    console.error("[notify] Resend send threw:", err);
    return { ok: false, error: "network" };
  }
}
