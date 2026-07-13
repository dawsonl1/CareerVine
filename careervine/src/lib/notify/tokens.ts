import crypto from "crypto";

/**
 * One-click unsubscribe tokens (CAR-105). HMAC-SHA256 over a compact payload so an
 * UNAUTHENTICATED `GET/POST /api/notifications/unsubscribe` can identify the user +
 * notification purpose without a session and can't be forged. No existing signer to
 * reuse — `lib/crypto.ts` is reversible AES-256-GCM, not an HMAC signer.
 *
 * Token format: `${userId}.${purpose}.${sig}`. userId is a UUID (no dots), purpose
 * is a fixed slug (no dots), sig is base64url (no dots/padding), so a plain
 * split(".") always yields exactly three parts.
 */

function secret(): string {
  return process.env.NUDGE_UNSUBSCRIBE_SECRET || "";
}

export type NotificationPurpose = "followup_nudges";

export function signUnsubscribeToken(userId: string, purpose: NotificationPurpose): string {
  const payload = `${userId}.${purpose}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(
  token: string,
): { userId: string; purpose: NotificationPurpose } | null {
  // Fail CLOSED on a missing secret: HMAC-SHA256 with an empty key is a public,
  // reproducible function, so verifying against it would accept attacker-forged
  // tokens for any userId. Refuse to verify anything until the secret is set,
  // rather than silently trusting an empty-key MAC (CAR-105 review).
  const key = secret();
  if (!key) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, purpose, sig] = parts;
  if (purpose !== "followup_nudges") return null;

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${userId}.${purpose}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check guards timingSafeEqual against a throw on mismatched buffers.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { userId, purpose };
}
