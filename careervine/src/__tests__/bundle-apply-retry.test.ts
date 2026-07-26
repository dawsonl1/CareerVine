import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchStepWithRetry } from "@/lib/bundle-apply-client";

/**
 * The cursor-loop retry state machine (CAR-207 review).
 *
 * CAR-207 replaced a helper its own docblock called "battle-tested" — one that
 * handed back a raw `Response` — with a discriminated `StepOutcome` routed
 * through `apiFetch`, and shipped it with no direct test at all: measured 0%
 * branch coverage over the retry loop. Every difference between the old and new
 * behavior therefore lived in code nothing exercised.
 *
 * So this pins the whole decision table rather than a happy path. What each
 * class must do, and why:
 *
 *   - a 4xx the ROUTE authored is a verdict about this step: report it, do not
 *     retry, and surface the route's own curated message.
 *   - everything else is transient and must be retried twice before giving up:
 *     a 5xx, a network failure, a 2xx whose body will not parse, and a 4xx with
 *     no parseable body (which `withApiHandler` cannot produce, so it came from
 *     the edge and is as transient as a 5xx).
 *
 * `null` is the give-up signal, and both callers turn it into the honest
 * background-handoff copy, so misclassifying a transient failure as terminal
 * costs the user a true message and replaces it with generic copy.
 */

type Step = { done: boolean; applied: number };

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What an edge/CDN/WAF page looks like: right status, unparseable body. */
const html = (status: number) => () =>
  new Response("<html><body>Gateway</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });

const network = () => () => {
  throw new TypeError("fetch failed");
};

/**
 * Drive the helper against a scripted response sequence. The last entry repeats,
 * so a single-element script means "every attempt answers this".
 */
async function run(script: Array<() => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return script[Math.min(calls.length - 1, script.length - 1)]();
    }),
  );
  const pending = fetchStepWithRetry<Step>("/api/bundles/apply", { bundleId: 3 });
  // The backoff is 2s then 4s; without this the test would take six seconds.
  await vi.runAllTimersAsync();
  return { outcome: await pending, attempts: calls.length, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchStepWithRetry — terminal answers (no retry)", () => {
  it("returns a 2xx step on the first attempt", async () => {
    const { outcome, attempts, calls } = await run([json(200, { done: true, applied: 42 })]);

    expect(attempts).toBe(1);
    expect(outcome).toEqual({ ok: true, step: { done: true, applied: 42 }, retried: false });
    expect(calls[0]).toBe("/api/bundles/apply");
  });

  it("reports a route-authored 4xx once, with the route's own message", async () => {
    const { outcome, attempts } = await run([json(400, { error: "Bundle not found" })]);

    expect(attempts).toBe(1);
    expect(outcome).toEqual({ ok: false, status: 400, error: "Bundle not found", retried: false });
  });

  it("reports a 409 without retrying, so the caller can hand off to the other driver", async () => {
    // runBundleApplyLoop reads status 409 + retried:false as "another driver
    // owns this sync" and returns completed:false silently. Retrying here would
    // turn a normal handoff into an error toast.
    const { outcome, attempts } = await run([
      json(409, { error: "A sync is already running for this subscription" }),
    ]);

    expect(attempts).toBe(1);
    expect(outcome).toMatchObject({ ok: false, status: 409, retried: false });
  });
});

describe("fetchStepWithRetry — transient answers (retried, then null)", () => {
  it("retries a 5xx twice and then gives up", async () => {
    const { outcome, attempts } = await run([json(500, { error: "boom" })]);

    expect(attempts).toBe(3);
    expect(outcome).toBeNull();
  });

  it("retries a function-timeout 504 whose body is HTML", async () => {
    const { outcome, attempts } = await run([html(504)]);

    expect(attempts).toBe(3);
    expect(outcome).toBeNull();
  });

  it("retries a network failure", async () => {
    const { outcome, attempts } = await run([network()]);

    expect(attempts).toBe(3);
    expect(outcome).toBeNull();
  });

  it("retries a 2xx whose body will not parse", async () => {
    // apiFetch reports this as `unreadable_response` at the ORIGINAL 2xx status,
    // so a status-only test would read it as a sub-500 verdict and stop.
    const { outcome, attempts } = await run([html(200)]);

    expect(attempts).toBe(3);
    expect(outcome).toBeNull();
  });

  it("retries a 4xx the route did not author", async () => {
    // withApiHandler always answers JSON, so an unparseable 4xx came from the
    // edge (a CDN page, a platform 429) and is as transient as a 5xx. Testing
    // status alone gave up on the first attempt and replaced unsubscribe's
    // honest "it will finish in the background" with generic copy.
    const { outcome, attempts } = await run([html(429)]);

    expect(attempts).toBe(3);
    expect(outcome).toBeNull();
  });
});

describe("fetchStepWithRetry — the retried flag", () => {
  it("marks a step that only succeeded after a server error", async () => {
    const { outcome, attempts } = await run([
      json(500, { error: "boom" }),
      json(200, { done: false, applied: 10 }),
    ]);

    expect(attempts).toBe(2);
    expect(outcome).toEqual({ ok: true, step: { done: false, applied: 10 }, retried: true });
  });

  it("marks a 409 that follows a server error, which is our own zombie claim", async () => {
    // This is the distinction the flag exists for: a 409 on a FRESH call means
    // another driver owns the sync (benign), but a 409 after our own call
    // 5xx'd is that dead call's claim still being held, and the user needs the
    // background-handoff message rather than silence.
    const { outcome, attempts } = await run([
      json(500, { error: "boom" }),
      json(409, { error: "A sync is already running for this subscription" }),
    ]);

    expect(attempts).toBe(2);
    expect(outcome).toMatchObject({ ok: false, status: 409, retried: true });
  });
});
