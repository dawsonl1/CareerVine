/**
 * Client-side bundle subscribe/apply driver, shared by Settings → Data
 * subscriptions and the guided onboarding flow (CAR-50). Extracted verbatim
 * from data-subscriptions-section.tsx so both surfaces run the identical,
 * battle-tested cursor loop (CAR-47 retry semantics included).
 */

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
};

export const BACKGROUND_SYNC_MESSAGE =
  "The sync hit a server error. It will keep running in the background — your contacts will appear shortly.";

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
): Promise<{ res: Response; step: T & { error?: string }; retried: boolean } | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status < 500) {
        return { res, step: (await res.json()) as T & { error?: string }, retried: attempt > 0 };
      }
    } catch {
      // Network failure or non-JSON body — treated like a 5xx.
    }
    if (attempt >= 2) return null;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

/** Subscribe to a bundle; throws with a user-facing message on failure. */
export async function subscribeToBundle(bundleId: number): Promise<void> {
  const res = await fetch("/api/bundles/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleId }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Subscribe failed");
}

/**
 * Run the chunked apply loop until the sync completes. Returns true when this
 * driver finished the sync, false when another driver (worker/cron) owns it.
 * Throws BACKGROUND_SYNC_MESSAGE when the server errored but a background
 * job will finish the work.
 */
export async function runBundleApplyLoop(
  bundle: { id: number; prospect_count: number },
  onProgress?: (progress: ApplyProgress) => void,
): Promise<boolean> {
  let cursor: ApplyStep["nextCursor"] = null;
  let pinnedVersion: number | undefined;
  let claimToken: string | undefined;
  let applied = 0;
  onProgress?.({ applied: 0, total: bundle.prospect_count });
  for (;;) {
    const outcome: { res: Response; step: ApplyStep & { error?: string }; retried: boolean } | null =
      await fetchStepWithRetry<ApplyStep>("/api/bundles/apply", {
        bundleId: bundle.id,
        cursor,
        pinnedVersion,
        claimToken,
      });
    if (!outcome) {
      // Subscribe also enqueued a delayed background job (CAR-47),
      // so this failure message is honest.
      throw new Error(BACKGROUND_SYNC_MESSAGE);
    }
    const res: Response = outcome.res;
    const step: ApplyStep & { error?: string } = outcome.step;
    const retried: boolean = outcome.retried;
    if (!res.ok) {
      if (res.status === 409) {
        // After a server error, the 409 is our own dead call's zombie
        // claim — surface the background handoff instead of silence.
        if (retried) throw new Error(BACKGROUND_SYNC_MESSAGE);
        // Otherwise another driver (worker/cron) is already syncing — fine.
        return false;
      }
      throw new Error(step.error ?? "Sync failed");
    }
    applied += step.applied;
    pinnedVersion = step.pinnedVersion;
    claimToken = step.claimToken ?? claimToken;
    onProgress?.({ applied, total: bundle.prospect_count });
    if (step.done) return true;
    cursor = step.nextCursor;
  }
}
