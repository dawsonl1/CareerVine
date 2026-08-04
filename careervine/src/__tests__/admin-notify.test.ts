/**
 * CAR-220: the owner-alert channel must never be able to hold up a send.
 *
 * `notifyOwner` is awaited by `checkWatcherHealth`, which the hourly
 * send-scheduled-emails route awaits under `maxDuration = 60`. The alert only
 * fires when the watcher is already dead, i.e. when that hourly QStash tick is
 * the ONLY thing delivering mail — so an unbounded fetch there means the alert
 * about degraded delivery is what stops delivery: Vercel kills the function at
 * 60s (uncatchable), the sweep never runs, and QStash's retries each re-enter
 * and hang the same way because `last_alerted_at` is only stamped after this
 * resolves.
 *
 * undici's defaults do not save it: no `signal` means the request can sit for
 * 300s. The bound has to be explicit and small.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyOwner } from "@/lib/admin-notify";

const OLD_KEY = process.env.RESEND_API_KEY;

/** The last init object fetch was called with. */
let lastInit: RequestInit | undefined;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  lastInit = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

function stubFetch(impl: (init: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      lastInit = init;
      return impl(init);
    }),
  );
}

describe("notifyOwner — bounded request", () => {
  it("passes an abort signal so the request cannot outlive the function budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(async () => new Response("{}", { status: 200 }));

    await expect(notifyOwner("subject", "body")).resolves.toBe(true);

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
    expect((lastInit!.signal as AbortSignal).aborted).toBe(false);
  });

  it("bounds the wait well inside the 60s route budget", async () => {
    // The number itself is the fix. An alert that can eat the whole budget is
    // the defect; anything past ~15s leaves too little for the sweep that is
    // the only reason the function is running at all.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(async () => new Response("{}", { status: 200 }));

    await notifyOwner("subject", "body");

    const ms = timeoutSpy.mock.calls[0][0] as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(15_000);
  });

  it("resolves false (never hangs, never throws) when the request is aborted", async () => {
    // The hang, simulated: fetch settles only when the signal fires. Without a
    // signal this promise is the 60s function kill; with one it is a bounded
    // false, the caller skips the `last_alerted_at` stamp, and the next hourly
    // tick retries. Delivery is untouched either way.
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "TimeoutError")),
          );
        }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = notifyOwner("subject", "body");
    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      expect.anything(),
    );
  });

  it("still reports a non-2xx Resend response as undelivered", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(async () => new Response("nope", { status: 429 }));

    await expect(notifyOwner("subject", "body")).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });
});
