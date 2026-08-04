/**
 * NDR (bounce) parsing — pure, so it can be tested without a Gmail double.
 *
 * `detectBounces` used to treat the presence of an `X-Failed-Recipients` header
 * as proof that an address is dead. Two things are wrong with that, and both
 * matter because marking an address bounced is DESTRUCTIVE: it blocks every
 * future send to it (`sendTrackedEmail` throws a 422), retires the follow-up
 * sequence, and cancels queued scheduled mail. A false positive silently ends a
 * real relationship; a false negative only costs a retry. So the whole module is
 * biased toward extracting NOTHING when the evidence is ambiguous.
 *
 * 1. A DELAY is not a failure. Gmail sends "Delivery Status Notification
 *    (Delay)" from the same mailer-daemon address, with the same header, while
 *    it is still retrying. Acting on one kills an address that is about to
 *    deliver fine.
 * 2. `X-Failed-Recipients` is a Gmail-ism. When the recipient's own MTA
 *    generates the rejection (Microsoft 365 and friends bounce with
 *    "Undeliverable: ..."), there is no such header — the failed address lives
 *    in an RFC 3464 `message/delivery-status` part instead. Those bounces
 *    matched the search query and then yielded nothing at all.
 *
 * Precedence: the delivery-status part is AUTHORITATIVE when present, because it
 * carries a per-recipient Action/Status and so can say "delayed" precisely. The
 * header is only consulted when no such part exists, and is then trusted unless
 * the subject explicitly says delay — that keeps every bounce the old code
 * caught, and subtracts only the recognized-delay false positive.
 */

/** The subset of a Gmail message payload this parse needs. Structurally
 *  compatible with gmail_v1.Schema$MessagePart, minus everything unused. */
export interface BouncePart {
  mimeType?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: { data?: string | null } | null;
  parts?: BouncePart[] | null;
}

/** Why a candidate NDR produced no addresses — logged, never user-facing. */
export type BounceSkipReason = "delayed" | "no_recipients";

export interface BounceVerdict {
  /** Permanently-failed recipients, lowercased and trimmed. */
  addresses: string[];
  /** Set only when `addresses` is empty, explaining which case this was. */
  skipped?: BounceSkipReason;
}

const EMPTY_DELAYED: BounceVerdict = { addresses: [], skipped: "delayed" };
const EMPTY_NONE: BounceVerdict = { addresses: [], skipped: "no_recipients" };

function headerValue(part: BouncePart | null | undefined, name: string): string {
  const found = (part?.headers ?? []).find(
    (h) => (h?.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return (found?.value ?? "").trim();
}

/**
 * Strip an RFC 3464 address to its bare form: `rfc822; <a@b.com>` -> `a@b.com`.
 * The address-type prefix and the angle brackets are both optional in the wild.
 */
function normalizeRecipient(raw: string): string {
  let value = raw.trim();
  const semi = value.indexOf(";");
  if (semi !== -1) value = value.slice(semi + 1);
  value = value.trim();
  const angled = value.match(/<(.+?)>/);
  if (angled) value = angled[1];
  return value.trim().toLowerCase();
}

/**
 * True when a subject names a transient delay rather than a permanent failure.
 * Only consulted on the header fallback path, where no Action/Status exists.
 */
export function subjectIndicatesDelay(subject: string): boolean {
  return /\bdelay(ed|ing)?\b/i.test(subject);
}

/** Unfold RFC 5322 continuation lines (a line beginning with space or tab
 *  continues the previous one) so a wrapped Final-Recipient still parses. */
function unfold(body: string): string[] {
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse one `message/delivery-status` body (RFC 3464).
 *
 * The body is a per-message field group, then one group per recipient,
 * separated by blank lines. The first group has no Final-Recipient and so
 * contributes nothing on its own. A recipient counts as permanently failed when
 * `Action: failed` or `Status: 5.x.x`; `4.x.x` / `Action: delayed` is a retry in
 * progress. Both fields are required by the RFC and routinely only one shows up,
 * so either alone is accepted and their disagreement resolves to "not failed".
 */
export function parseDeliveryStatus(body: string): BounceVerdict {
  const addresses = new Set<string>();
  let sawDelayed = false;

  let recipient = "";
  let action = "";
  let status = "";

  const flush = () => {
    if (recipient) {
      const permanent = action === "failed" || (!action && status.startsWith("5"));
      const transient = action === "delayed" || (!action && status.startsWith("4"));
      // An explicit `failed` with a 4.x.x status is contradictory; treat the
      // pair as unresolved rather than guessing, per the bias above.
      const contradicted =
        (action === "failed" && status.startsWith("4")) ||
        (action === "delayed" && status.startsWith("5"));

      if (permanent && !contradicted) addresses.add(recipient);
      else if (transient || contradicted) sawDelayed = true;
    }
    recipient = "";
    action = "";
    status = "";
  };

  for (const line of unfold(body)) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "final-recipient" || (field === "original-recipient" && !recipient)) {
      recipient = normalizeRecipient(value);
    } else if (field === "action") {
      action = value.toLowerCase();
    } else if (field === "status") {
      status = value;
    }
  }
  flush();

  if (addresses.size > 0) return { addresses: [...addresses] };
  return sawDelayed ? EMPTY_DELAYED : EMPTY_NONE;
}

/** Depth-first search for the first `message/delivery-status` part's decoded body. */
function findDeliveryStatusBody(part: BouncePart | null | undefined): string | null {
  if (!part) return null;
  if ((part.mimeType ?? "").toLowerCase() === "message/delivery-status" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const found = findDeliveryStatusBody(child);
    if (found) return found;
  }
  return null;
}

/**
 * Extract permanently-failed recipients from one candidate NDR.
 *
 * `payload` may be omitted (a metadata-format fetch), in which case only the
 * header path is available. Callers use that to stay cheap: fetch metadata
 * first, and only re-fetch `full` for messages the header could not resolve.
 */
export function extractFailedRecipients(opts: {
  /** Message-level headers (X-Failed-Recipients, Subject). */
  headers: Array<{ name?: string | null; value?: string | null }>;
  /** Full payload, when available. */
  payload?: BouncePart | null;
}): BounceVerdict {
  const deliveryStatus = findDeliveryStatusBody(opts.payload);
  if (deliveryStatus !== null) {
    const verdict = parseDeliveryStatus(deliveryStatus);
    // Authoritative even when it yields nothing: a part that says "delayed" must
    // not fall through to a header that cannot tell delay from failure.
    if (verdict.addresses.length > 0 || verdict.skipped === "delayed") return verdict;
  }

  const failed = headerValue({ headers: opts.headers }, "X-Failed-Recipients");
  if (!failed) return EMPTY_NONE;

  if (subjectIndicatesDelay(headerValue({ headers: opts.headers }, "Subject"))) {
    return EMPTY_DELAYED;
  }

  const addresses = failed
    .split(",")
    .map((a) => normalizeRecipient(a))
    .filter(Boolean);

  return addresses.length > 0 ? { addresses: [...new Set(addresses)] } : EMPTY_NONE;
}

/**
 * True when a message still needs a `full` fetch to be resolved: the cheap
 * metadata pass found no usable header, so the answer (if any) is in a
 * delivery-status part.
 */
export function needsFullFetch(headers: Array<{ name?: string | null; value?: string | null }>): boolean {
  return !headerValue({ headers }, "X-Failed-Recipients");
}
