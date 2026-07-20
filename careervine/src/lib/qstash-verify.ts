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

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
}

/**
 * Verify a QStash `upstash-signature` and run `handler` with the raw request
 * body only if it checks out. Returns 401 (handler never called) when the
 * signing keys are unset or the signature is invalid.
 */
export async function withQStashVerification(
  req: NextRequest,
  handler: (body: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const body = await req.text();

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

  return handler(body);
}

/** @internal Test hook — drop the memoized Receiver so a test can swap env. */
export function resetQStashReceiverForTests(): void {
  cached = null;
}
