/**
 * Single QStash-signature chokepoint for every signed webhook route (CAR-149,
 * F43). Before this, each of the 9 consumers (8 cron routes + queue/bundle-sync)
 * inlined its own `new Receiver({ ... || "" })` + verify block, so a wiring slip
 * — an empty-key Receiver silently accepting everything, a missing 401 branch —
 * would be invisible and per-route. This wrapper:
 *
 *   - constructs the Receiver ONCE (memoized on the signing-key values),
 *   - explicitly REFUSES with 401 when QSTASH_CURRENT/NEXT_SIGNING_KEY are unset
 *     (never constructs a permissive empty-key Receiver),
 *   - returns 401 on any verification failure,
 *   - invokes the handler with the verified raw body ONLY on success.
 *
 * The handler-callback shape (like withCronGuard) makes "unsigned → handler
 * never runs" a directly testable invariant.
 */

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";

let cached: { receiver: Receiver; current: string; next: string } | null = null;

/**
 * The shared Receiver, or null when either signing key is unset. Memoized on the
 * key values so a key rotation (or a test swapping env) transparently rebuilds it.
 */
function getReceiver(): Receiver | null {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) return null;
  if (!cached || cached.current !== current || cached.next !== next) {
    cached = {
      receiver: new Receiver({ currentSigningKey: current, nextSigningKey: next }),
      current,
      next,
    };
  }
  return cached.receiver;
}

/**
 * Which credential got the caller in. The send routes use this to keep the two
 * drivers honest about each other: the watcher stamps liveness, and QStash (the
 * safety net) notices when that stamp goes stale and emails.
 */
export type CronAuthSource = "qstash" | "watcher";

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
}

/**
 * Constant-time string compare that does not leak length through early return.
 *
 * `timingSafeEqual` throws on unequal buffer lengths, which would itself be a
 * length oracle, so both sides are hashed to a fixed width first.
 */
function secretsMatch(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * True when the request carries the shared cron-trigger bearer (CAR-215).
 *
 * The A1 watcher drives sends at ~15s resolution and cannot produce a QStash
 * signature, so it authenticates with a dedicated secret instead. It is a
 * SEPARATE credential from every other secret in the system.
 *
 * Only consulted when the caller opts in via `allowCronBearer` (CAR-220).
 * Before that it was checked here for every consumer of this wrapper, so one
 * shared secret opened all nine: the two send routes it was minted for, plus
 * both destructive purges, both paid-Apify routes, the QStash fan-out, the
 * nudge mailer, and the bundle-sync queue. What the bearer can cause is
 * therefore bounded by the opt-in list, not by anything in this file — which
 * routes opt in is pinned in `src/__tests__/route-auth-inventory.test.ts`.
 *
 * Fails closed when unset, exactly like the signing keys.
 */
function hasValidCronBearer(req: NextRequest): boolean {
  const expected = process.env.CRON_TRIGGER_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;
  return secretsMatch(presented, expected);
}

export interface QStashVerificationOptions {
  /**
   * Also accept `Authorization: Bearer <CRON_TRIGGER_SECRET>` (CAR-215's A1
   * watcher). Defaults to false — a route that does not ask for the bearer
   * refuses it with the same 401 as any other unsigned request.
   *
   * Two things to weigh before setting it on a new route:
   *  - the bearer carries no body signature, so on an opted-in route the body
   *    reaching `handler` is chosen by whoever holds the secret. Only pass this
   *    on a route whose handler ignores the body or validates it itself.
   *  - one leaked secret then reaches every opted-in route at once. Keep the
   *    set as small as the watcher actually needs.
   */
  allowCronBearer?: boolean;
}

/**
 * Verify a QStash `upstash-signature` and run `handler` with the raw request
 * body only if it checks out. Returns 401 (handler never called) when the
 * signing keys are unset or the signature is invalid.
 *
 * With `opts.allowCronBearer`, a valid `Authorization: Bearer
 * <CRON_TRIGGER_SECRET>` is accepted as an alternative, so the A1 watcher can
 * drive that route at a resolution QStash polling cannot reach. Both paths land
 * on the same handler, which learns which credential got the caller in through
 * its `source` argument.
 *
 * Default closed: with the option absent or false the bearer is not consulted
 * at all, so a request carrying both a bearer and a valid signature is admitted
 * as `"qstash"`. Pinned in `src/__tests__/qstash-verify.test.ts`.
 */
export async function withQStashVerification(
  req: NextRequest,
  handler: (body: string, source: CronAuthSource) => Promise<NextResponse>,
  opts: QStashVerificationOptions = {},
): Promise<NextResponse> {
  const body = await req.text();

  // Checked before the signature so the watcher's calls skip Receiver
  // construction entirely; it is the high-frequency caller. `=== true` rather
  // than truthiness, so anything other than the literal flag leaves the route
  // closed.
  if (opts.allowCronBearer === true && hasValidCronBearer(req)) {
    return handler(body, "watcher");
  }

  const receiver = getReceiver();
  if (!receiver) {
    // Fail closed: a signed-webhook route with no keys must never accept an
    // unverifiable request. Error-level so a misconfigured deploy is loud.
    console.error(
      "[qstash-verify] QSTASH_CURRENT/NEXT_SIGNING_KEY unset — refusing QStash request (401)",
    );
    return unauthorized();
  }

  const signature = req.headers.get("upstash-signature") || "";
  try {
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return unauthorized();
  }

  return handler(body, "qstash");
}

/** @internal Test hook — drop the memoized Receiver so a test can swap env. */
export function resetQStashReceiverForTests(): void {
  cached = null;
}
