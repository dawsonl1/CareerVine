/**
 * Shared recipient-address policy for the email tools (draft, send,
 * schedule, sequence): refuse bounced addresses everywhere, warn on
 * pattern-guessed addresses. The daily send cap is enforced separately
 * inside the app's sendTrackedEmail() — server-side, so a runaway loop
 * can't torch deliverability.
 */

export interface EmailRowLike {
  email: string | null;
  is_primary: boolean;
  source: string;
  bounced_at: string | null;
}

export interface ResolvedRecipient {
  email: string;
  source: string;
  warnings: string[];
}

/**
 * Pick the recipient address for a contact: the explicit override if
 * given (must be one of the contact's known addresses OR is accepted
 * verbatim with a warning), else the primary, else the first address.
 * Throws on bounced or missing addresses.
 */
export function resolveRecipient(
  contactName: string,
  emails: EmailRowLike[],
  override?: string,
): ResolvedRecipient {
  const known = emails.filter((e): e is EmailRowLike & { email: string } => Boolean(e.email));
  const warnings: string[] = [];

  if (override) {
    const target = override.trim().toLowerCase();
    const match = known.find((e) => e.email.toLowerCase() === target);
    if (match?.bounced_at) {
      throw new Error(
        `${match.email} has bounced before — refusing to use it. Verify or update the address first.`,
      );
    }
    if (match?.source === "pattern_guessed") {
      warnings.push(`${match.email} is pattern-guessed and unverified, so it may bounce.`);
    }
    if (!match) {
      warnings.push(`${target} is not one of ${contactName}'s saved addresses, using it as given.`);
    }
    return { email: target, source: match?.source ?? "override", warnings };
  }

  const usable = known.filter((e) => !e.bounced_at);
  if (known.length > 0 && usable.length === 0) {
    throw new Error(
      `All of ${contactName}'s email addresses have bounced — refusing to send. Find a working address first.`,
    );
  }
  const pick = usable.find((e) => e.is_primary) ?? usable[0];
  if (!pick) {
    throw new Error(`${contactName} has no email address on file.`);
  }
  if (pick.source === "pattern_guessed") {
    warnings.push(`${pick.email} is pattern-guessed and unverified, so it may bounce.`);
  }
  return { email: pick.email.toLowerCase(), source: pick.source, warnings };
}
