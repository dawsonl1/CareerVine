// @vitest-environment jsdom
/**
 * CAR-229: session replay must not sit on the first-paint path.
 *
 * PostHog's recorder is a separate rrweb script fetched from the PostHog host,
 * and initialising with session recording on pulled it during first paint on
 * every route. The fix is `disable_session_recording: true` at init plus a
 * deferred `startSessionRecording()` once the page has loaded and gone idle, so
 * WHAT gets recorded is unchanged and only WHEN it starts moves.
 *
 * These tests spy on the real posthog-js singleton rather than replacing the
 * module: the assertions are about the exact init options and the call ordering,
 * and a hand-rolled fake of posthog-js would drift from both.
 *
 * Module-level `initialized` / `recordingScheduled` flags make ensureInit()
 * once-only, so every test re-imports the module after vi.resetModules() and
 * re-installs its spies on whichever singleton that fresh graph resolves to.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "phc_test";

let idleCallbacks: Array<() => void> = [];

/** Capture requestIdleCallback work so a test can decide when the browser idles. */
function installIdleCallback(): void {
  idleCallbacks = [];
  window.requestIdleCallback = ((cb: IdleRequestCallback) => {
    idleCallbacks.push(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
    return 1;
  }) as typeof window.requestIdleCallback;
}

function removeIdleCallback(): void {
  delete (window as unknown as Record<string, unknown>).requestIdleCallback;
}

function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, "readyState", { value: state, configurable: true });
}

/**
 * A fresh analytics client plus spies on the posthog singleton it uses.
 * posthog-js is imported after the reset so both halves agree on the instance
 * whether or not vitest externalises the dependency.
 */
async function loadClient() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
  const posthog = (await import("posthog-js")).default;
  const init = vi.spyOn(posthog, "init").mockImplementation(() => posthog);
  const startSessionRecording = vi
    .spyOn(posthog, "startSessionRecording")
    .mockImplementation(() => {});
  const hasOptedOut = vi.spyOn(posthog, "has_opted_out_capturing").mockReturnValue(false);
  const mod = await import("@/lib/analytics/client");
  return { ...mod, init, startSessionRecording, hasOptedOut };
}

beforeEach(() => {
  vi.useFakeTimers();
  installIdleCallback();
  setReadyState("complete");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeIdleCallback();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("ensureInit", () => {
  it("initialises with recording off but autocapture and masking intact", async () => {
    const { ensureInit, init } = await loadClient();

    expect(ensureInit()).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);

    const [key, options] = init.mock.calls[0];
    expect(key).toBe(KEY);
    expect(options).toMatchObject({
      autocapture: true,
      person_profiles: "identified_only",
      // Off at init only — scheduleSessionRecording turns it back on.
      disable_session_recording: true,
      // Masking is configured up front so it is already in force the moment
      // recording starts.
      session_recording: { maskAllInputs: true, maskTextSelector: "[data-ph-mask]" },
    });
  });

  it("does not start the recorder during init", async () => {
    const { ensureInit, startSessionRecording } = await loadClient();
    ensureInit();
    expect(startSessionRecording).not.toHaveBeenCalled();
  });

  it("starts the recorder once the browser goes idle", async () => {
    const { ensureInit, startSessionRecording } = await loadClient();
    ensureInit();

    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks.forEach((run) => run());
    expect(startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("waits for the load event when the document is still parsing", async () => {
    setReadyState("loading");
    const { ensureInit, startSessionRecording } = await loadClient();
    ensureInit();

    // Nothing queued yet — the idle wait has not even been requested.
    expect(idleCallbacks).toHaveLength(0);

    window.dispatchEvent(new Event("load"));
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks.forEach((run) => run());
    expect(startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("falls back to a macrotask where requestIdleCallback is missing", async () => {
    removeIdleCallback();
    const { ensureInit, startSessionRecording } = await loadClient();
    ensureInit();

    expect(startSessionRecording).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("never resurrects recording for an opted-out (internal) account", async () => {
    const { ensureInit, startSessionRecording, hasOptedOut } = await loadClient();
    ensureInit();
    // AnalyticsProvider opts internal accounts out as soon as the session
    // resolves, which can land before the idle callback runs.
    hasOptedOut.mockReturnValue(true);

    idleCallbacks.forEach((run) => run());
    expect(startSessionRecording).not.toHaveBeenCalled();
  });

  it("schedules the recorder once no matter how often ensureInit is called", async () => {
    const { ensureInit, init, startSessionRecording } = await loadClient();
    ensureInit();
    ensureInit();
    ensureInit();

    expect(init).toHaveBeenCalledTimes(1);
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks.forEach((run) => run());
    expect(startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all without a PostHog key", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const posthog = (await import("posthog-js")).default;
    const init = vi.spyOn(posthog, "init").mockImplementation(() => posthog);
    const { ensureInit } = await import("@/lib/analytics/client");

    expect(ensureInit()).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(idleCallbacks).toHaveLength(0);
  });
});
