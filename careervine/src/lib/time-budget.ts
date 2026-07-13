/**
 * Wall-clock backstop for budgeted route handlers (CAR-112).
 *
 * The bundle-sync apply loops enforce their budget *cooperatively*: they check
 * the deadline between chunks and never interrupt a chunk in flight — that
 * keeps each step's writes atomic. The cost is that a single slow step started
 * near the budget edge can overrun Vercel's `maxDuration` and get hard-killed
 * mid-write. A hard kill skips the handler's graceful re-enqueue, so QStash
 * retries the whole batch 3× — the exact amplification CAR-106 fought.
 *
 * `runWithResponseDeadline` races `work` against a wall-clock timer. Every step
 * in these loops is an awaited DB round-trip, so the timer fires on the event
 * loop even while a step is pending. When the deadline wins we run `onDeadline`
 * (graceful re-enqueue / partial response) and return before the platform kill.
 * The abandoned `work` promise keeps running until Vercel freezes the function;
 * that is safe because the sync is idempotent and checkpoint-resumed (CAR-54),
 * so any partial writes are re-derived on the next run.
 *
 * `Promise.race` subscribes to `work`, so a late rejection of the abandoned
 * promise is still "handled" and never surfaces as an unhandledRejection.
 */
export async function runWithResponseDeadline<T>(
  msFromNow: number,
  work: Promise<T>,
  onDeadline: () => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineHit = Symbol("response-deadline");
  const timeout = new Promise<typeof deadlineHit>((resolve) => {
    timer = setTimeout(() => resolve(deadlineHit), Math.max(0, msFromNow));
  });
  try {
    const winner = await Promise.race([work, timeout]);
    return winner === deadlineHit ? await onDeadline() : (winner as T);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
