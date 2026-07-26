/**
 * Client-side bundle subscribe/apply driver, shared by Settings → Data
 * subscriptions and the guided onboarding flow (CAR-50). Extracted verbatim
 * from data-subscriptions-section.tsx so both surfaces run the identical,
 * battle-tested cursor loop (CAR-47 retry semantics included).
 */

import {
  apiFetch,
  apiSend,
  isApiRequestError,
  jsonBody,
  UNREADABLE_RESPONSE_CODE,
} from "@/lib/api-client";

export type ApplyProgress = {
  applied: number;
  total: number;
};

export type ApplyStep = {
  done: boolean;
  nextCursor: { phase: "apply" | "remove" | "fast"; afterId: number } | null;
  pinnedVersion: number;
  applied: number;
  claimToken?: string;
  /** Which server path applied this call's work (CAR-78 instrumentation). */
  path?: "fast" | "merge";
};

export type ApplyLoopOutcome = {
  /** True when this driver finished the sync; false when another driver
   * (worker/cron) owns it. */
  completed: boolean;
  /** Path reported by the final apply response, for analytics. */
  path?: "fast" | "merge";
};

export const BACKGROUND_SYNC_MESSAGE =
  "The sync hit a server error. It will keep running in the background, and your contacts will appear shortly.";

/**
 * The outcome of one cursor-loop step, discriminated on whether the route
 * accepted it. This used to hand back the raw `Response` so callers could read
 * `res.ok` and `res.status` themselves, which is what kept a raw `fetch` on a
 * browser path (CAR-207): the URL is a parameter here, so the conventions guard
 * — which outside the client tree only fires on a literal `/api/…` — could not
 * see it. `ApiRequestError` already carries status, code and the curated
 * message, so nothing needed the Response object.
 */
export type StepOutcome<T> =
  | { ok: true; step: T; retried: boolean }
  | { ok: false; status: number; error: string; retried: boolean };

/**
 * POST one cursor-loop step. A 5xx (e.g. a function timeout's 504, whose
 * body is HTML rather than JSON) or a network failure is retried twice with
 * backoff before giving up (CAR-47); null means all attempts failed.
 * `retried` marks a step that only succeeded after a server error — a 409
 * on such a step usually means the failed call's claim is still held, not
 * that another driver is genuinely syncing.
 */
export async function fetchStepWithRetry<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<StepOutcome<T> | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, step: await apiFetch<T>(url, jsonBody(body)), retried: attempt > 0 };
    } catch (err) {
      // A curated 4xx is the route's verdict on this step, so report it rather
      // than hammering it twice more. Everything else is transient and gets
      // retried: a 5xx, a network failure, a 2xx whose body never parsed, and
      // — via the `body` test — any 4xx the ROUTE did not author.
      //
      // That last one matters. `withApiHandler` always answers JSON, so a 4xx
      // with no parseable body came from the edge (a CDN/WAF page, a platform
      // 429), which is exactly as transient as a 5xx. Testing only the status
      // gave up immediately on those, and the cost landed on unsubscribe: the
      // old code reached the honest "cleanup will finish in the background"
      // message, the status-only test replaced it with "Something went wrong."
      if (
        isApiRequestError(err) &&
        err.status < 500 &&
        err.code !== UNREADABLE_RESPONSE_CODE &&
        err.body !== undefined
      ) {
        return { ok: false, status: err.status, error: err.message, retried: attempt > 0 };
      }
    }
    if (attempt >= 2) return null;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

/** Subscribe to a bundle; throws with a user-facing message on failure. */
export async function subscribeToBundle(bundleId: number): Promise<void> {
  // apiSend throws ApiRequestError carrying the route's own message on a
  // non-2xx, which is exactly what the hand-rolled parse below reconstructed.
  await apiSend("/api/bundles/subscribe", jsonBody({ bundleId }));
}

/**
 * Run the chunked apply loop until the sync completes. Resolves with
 * completed: true when this driver finished the sync, false when another
 * driver (worker/cron) owns it. Throws BACKGROUND_SYNC_MESSAGE when the
 * server errored but a background job will finish the work.
 */
export async function runBundleApplyLoop(
  bundle: { id: number; prospect_count: number },
  onProgress?: (progress: ApplyProgress) => void,
): Promise<ApplyLoopOutcome> {
  let cursor: ApplyStep["nextCursor"] = null;
  let pinnedVersion: number | undefined;
  let claimToken: string | undefined;
  let path: ApplyLoopOutcome["path"];
  let applied = 0;
  onProgress?.({ applied: 0, total: bundle.prospect_count });
  for (;;) {
    // Annotated, not inferred: `cursor`/`pinnedVersion`/`claimToken` are fed
    // back into the next iteration's arguments from this very result, and
    // without the annotation tsc calls that a circular initializer (TS7022).
    const outcome: StepOutcome<ApplyStep> | null = await fetchStepWithRetry<ApplyStep>(
      "/api/bundles/apply",
      { bundleId: bundle.id, cursor, pinnedVersion, claimToken },
    );
    if (!outcome) {
      // Subscribe also enqueued a delayed background job (CAR-47),
      // so this failure message is honest.
      throw new Error(BACKGROUND_SYNC_MESSAGE);
    }
    if (!outcome.ok) {
      if (outcome.status === 409) {
        // After a server error, the 409 is our own dead call's zombie
        // claim — surface the background handoff instead of silence.
        if (outcome.retried) throw new Error(BACKGROUND_SYNC_MESSAGE);
        // Otherwise another driver (worker/cron) is already syncing — fine.
        return { completed: false };
      }
      throw new Error(outcome.error);
    }
    const step: ApplyStep = outcome.step;
    applied += step.applied;
    pinnedVersion = step.pinnedVersion;
    claimToken = step.claimToken ?? claimToken;
    path = step.path ?? path;
    onProgress?.({ applied, total: bundle.prospect_count });
    if (step.done) return { completed: true, path };
    cursor = step.nextCursor;
  }
}
