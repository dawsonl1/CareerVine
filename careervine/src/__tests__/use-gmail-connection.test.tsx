// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";

// The hook shares one module-level store across all instances, so each test
// re-imports a fresh copy of the module.
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());

type Deferred = {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
  reject: () => void;
};

function deferredFetch(): Deferred {
  let resolve!: (body: unknown) => void;
  let reject!: () => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = (body: unknown) =>
      res({ ok: true, json: () => Promise.resolve(body) } as Response);
    reject = () => rej(new Error("network down"));
  });
  return { promise, resolve, reject };
}

const CONNECTED = {
  connection: {
    calendar_scopes_granted: true,
    calendar_last_synced_at: null,
    availability_standard: null,
    availability_priority: null,
    calendar_list: [],
    busy_calendar_ids: [],
    calendar_timezone: "UTC",
  },
};

const NOT_CONNECTED = {
  connection: {
    ...CONNECTED.connection,
    calendar_scopes_granted: false,
  },
};

let fetchCalls: Deferred[];

beforeEach(() => {
  vi.resetModules();
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const d = deferredFetch();
      fetchCalls.push(d);
      return d.promise;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function freshHook() {
  const mod = await import("@/hooks/use-gmail-connection");
  return { mod, hook: renderHook(() => mod.useGmailConnection()) };
}

describe("useGmailConnection", () => {
  it("initial load: loading until the first fetch resolves, then data lands", async () => {
    const { hook } = await freshHook();
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.data).toBeNull();

    await act(async () => fetchCalls[0].resolve(NOT_CONNECTED));

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.calendarConnected).toBe(false);
  });

  it("refresh() is silent: loading stays false and stale data stays visible while the refetch is in flight (CAR-75 banner blink)", async () => {
    const { hook } = await freshHook();
    await act(async () => fetchCalls[0].resolve(NOT_CONNECTED));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    // Kick off a background refresh but do NOT resolve it yet.
    let refreshDone: Promise<void>;
    act(() => {
      refreshDone = hook.result.current.refresh();
    });

    // Mid-flight: no loading flip, current data still rendered.
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.data).not.toBeNull();
    expect(fetchCalls).toHaveLength(2);

    await act(async () => {
      fetchCalls[1].resolve(CONNECTED);
      await refreshDone;
    });
    expect(hook.result.current.calendarConnected).toBe(true);
  });

  it("a failed background refresh keeps the existing data", async () => {
    const { hook } = await freshHook();
    await act(async () => fetchCalls[0].resolve(CONNECTED));
    await waitFor(() => expect(hook.result.current.calendarConnected).toBe(true));

    await act(async () => {
      const p = hook.result.current.refresh();
      fetchCalls[1].reject();
      await p;
    });

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.calendarConnected).toBe(true);
  });

  it("invalidateGmailConnectionCache() still wipes the store for disconnect flows", async () => {
    const { mod, hook } = await freshHook();
    await act(async () => fetchCalls[0].resolve(CONNECTED));
    await waitFor(() => expect(hook.result.current.calendarConnected).toBe(true));

    act(() => mod.invalidateGmailConnectionCache());

    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.loading).toBe(true);
  });

  // ── Out-of-order responses (CAR-190) ──
  //
  // refresh() nulls the dedupe handle BEFORE the request it supersedes has
  // resolved, so two responses can be live against one shared store. Nothing
  // ordered them, and the onboarding flow polls this every 3s.

  it("a superseded refresh cannot overwrite a newer one", async () => {
    const { hook } = await freshHook();
    await act(async () => fetchCalls[0].resolve(NOT_CONNECTED));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = hook.result.current.refresh();
    });
    act(() => {
      newer = hook.result.current.refresh();
    });
    expect(fetchCalls).toHaveLength(3);

    // The newer request answers first and connects the account.
    await act(async () => {
      fetchCalls[2].resolve(CONNECTED);
      await newer;
    });
    expect(hook.result.current.calendarConnected).toBe(true);

    // Then the older one lands, still carrying the pre-connect snapshot. It
    // used to win, flipping the whole app back to "Connect Gmail" for a poll.
    await act(async () => {
      fetchCalls[1].resolve(NOT_CONNECTED);
      await older;
    });
    expect(hook.result.current.calendarConnected).toBe(true);
  });

  it("a response in flight when the cache is invalidated cannot restore it", async () => {
    const { mod, hook } = await freshHook();
    await act(async () => fetchCalls[0].resolve(CONNECTED));
    await waitFor(() => expect(hook.result.current.calendarConnected).toBe(true));

    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.refresh();
    });
    act(() => mod.invalidateGmailConnectionCache());
    expect(hook.result.current.data).toBeNull();

    // The disconnect raced a refresh that was already on the wire. Letting it
    // land would undo the disconnect the user just performed.
    await act(async () => {
      fetchCalls[1].resolve(CONNECTED);
      await pending;
    });
    expect(hook.result.current.data).toBeNull();
  });

  it("a stale response does not release the dedupe handle out from under a live one", async () => {
    // No data yet, so the mount effect's `fetchPromise` check is reachable —
    // that is the only place the handle is read without first being nulled.
    const { hook } = await freshHook();
    expect(fetchCalls).toHaveLength(1);

    // Supersede the initial request before it answers.
    act(() => {
      void hook.result.current.refresh();
    });
    expect(fetchCalls).toHaveLength(2);

    // Resolve only the STALE one, with a body the seq guard discards, so the
    // store still holds no data.
    await act(async () => fetchCalls[0].resolve({ connection: null }));
    expect(hook.result.current.data).toBeNull();

    // A new consumer mounts while the newer request is still in flight. If the
    // stale response had cleared the shared handle, this would fire a third
    // request against an endpoint that already has one outstanding.
    await freshHook();
    expect(fetchCalls).toHaveLength(2);
  });
});
