/**
 * Shared recipient-address policy for the email tools (draft, send,
 * schedule, sequence): refuse bounced addresses everywhere, refuse
 * unverified overrides unless explicitly allowed, warn on pattern-guessed
 * addresses. The daily send cap is enforced separately inside the app's
 * sendTrackedEmail() — server-side, so a runaway loop can't torch
 * deliverability.
 *
 * CAR-217 turned the unverified-override case from a WARNING into a refusal.
 * The warning did not work, and the reason it did not is worth writing down
 * because it generalizes to every guardrail on this surface: the caller here is
 * an LLM, and a warning returned alongside a success payload is advisory text
 * competing with everything else in its context, while a thrown error is not.
 * In the incident that prompted this, an agent guessed three `first.last@google.com`
 * addresses, received exactly this warning on each, sent anyway, and then
 * reported all three as delivered. Two of the three bounced.
 *
 * The escape hatch is a parameter rather than a stronger warning for the same
 * reason: a model cannot forget to pass something the schema requires, and
 * passing it is a deliberate act that shows up in the transcript.
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

/** Thrown when an override is not one of the contact's saved addresses and the
 *  caller did not opt in. Distinct type so tools can map it to guidance. */
export class UnverifiedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnverifiedAddressError";
  }
}

/**
 * Pick the recipient address for a contact: the explicit override if given
 * (which must be one of the contact's known addresses unless
 * `allowUnverified` is set), else the primary, else the first address.
 * Throws on bounced, unverified and missing addresses.
 */
export function resolveRecipient(
  contactName: string,
  emails: EmailRowLike[],
  override?: string,
  opts: { allowUnverified?: boolean } = {},
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
    if (!match && !opts.allowUnverified) {
      const saved = known.length > 0
        ? `Saved addresses: ${known.map((e) => e.email).join(", ")}.`
        : `${contactName} has no saved addresses.`;
      throw new UnverifiedAddressError(
        `${target} is not one of ${contactName}'s saved addresses, so it is a guess and guesses bounce. ` +
          `${saved} Use a saved address, or find a real one first (the app's Find Email searches LinkedIn). ` +
          `If you genuinely mean to send to an address CareerVine has never seen, pass allow_unverified_address: true.`,
      );
    }
    if (!match) {
      warnings.push(
        `${target} is not one of ${contactName}'s saved addresses and was accepted only because ` +
          `allow_unverified_address was set. It may well bounce.`,
      );
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
