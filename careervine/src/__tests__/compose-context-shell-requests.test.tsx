// @vitest-environment jsdom
/**
 * What `ComposeEmailProvider` costs on every page load (CAR-229).
 *
 * The provider is mounted in the root layout, so anything it fetches is paid by
 * all 12 authenticated routes. Two defects lived here:
 *
 *  1. it issued its OWN `gmail_connections` read (`getGmailConnection`, direct
 *     PostgREST) alongside the shared `/api/gmail/connection` store, whose
 *     column list is a strict superset — a whole round trip that could not
 *     learn anything new; and
 *  2. the unread badge picked its endpoint from `isFreeOutreach`, which reads
 *     `false` until `/api/capabilities` resolves. The effect therefore fired
 *     against `/api/gmail/unread` and then re-fired against
 *     `/api/gmail/follow-ups/awaiting-review` — two requests per load, the
 *     first one wrong for every free user.
 *
 * ── Why this file resolves responses by hand ──────────────────────────────
 *
 * `installFakeFetch` (the house harness, §h) answers every route immediately in
 * issue order, and defect 2 is an ORDERING defect: with capabilities resolving
 * first, the broken code reaches the right endpoint by luck and the test passes
 * on it. So the router below hands back deferred promises, letting each case
 * land `/api/gmail/connection` FIRST — the exact state that used to trigger the
 * wrong fetch — and assert nothing fired before capabilities arrived. Same
 * `"METHOD /url"` keying and same unmatched-is-a-failure discipline;
 * `use-gmail-connection.test.tsx` sets the precedent for deferring in this way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup, screen } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";

// The capability and connection stores are module-level singletons, so every
// case re-imports the module tree.
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());

const CAPABILITIES = "GET /api/capabilities";
const CONNECTION = "GET /api/gmail/connection";
const UNREAD = "GET /api/gmail/unread";
const AWAITING_REVIEW = "GET /api/gmail/follow-ups/awaiting-review";

const CONNECTION_ROW = {
  connection: {
    send_scope_granted: true,
    gmail_address: "me@gmail.com",
    calendar_scopes_granted: false,
    calendar_last_synced_at: null,
    availability_standard: null,
    availability_priority: null,
    calendar_list: [],
    busy_calendar_ids: [],
    calendar_timezone: null,
  },
};

type Pending = { key: string; settled: boolean; resolve: (body: unknown) => void };

function installDeferredFetch() {
  const pending: Pending[] = [];
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = new URL(raw, "http://localhost");
      const key = `${(init?.method ?? "GET").toUpperCase()} ${parsed.pathname}${parsed.search}`;
      calls.push(key);
      return new Promise<Response>((resolve) => {
        pending.push({
          key,
          settled: false,
          resolve: (body: unknown) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
        });
      });
    }),
  );

  return {
    calls,
    countOf: (key: string) => calls.filter((c) => c === key).length,
    /** Answer the oldest unanswered request for `key`. Throws if there is none. */
    settle(key: string, body: unknown) {
      const target = pending.find((p) => p.key === key && !p.settled);
      if (!target) {
        throw new Error(`no in-flight request for "${key}". Issued: ${calls.join(", ") || "(none)"}`);
      }
      target.settled = true;
      target.resolve(body);
    },
  };
}

let http: ReturnType<typeof installDeferredFetch>;

beforeEach(() => {
  vi.resetModules();
  http = installDeferredFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Surfaces the context values the rest of the app reads off this provider. */
async function renderProvider() {
  const { ComposeEmailProvider, useCompose } = await import("@/components/compose-email-context");

  function Probe() {
    const { unreadCount, gmailConnected, gmailLoading, gmailAddress, isFreeOutreach } = useCompose();
    return (
      <div>
        <span data-testid="unread">{unreadCount}</span>
        <span data-testid="connected">{String(gmailConnected)}</span>
        <span data-testid="loading">{String(gmailLoading)}</span>
        <span data-testid="address">{gmailAddress}</span>
        <span data-testid="free">{String(isFreeOutreach)}</span>
      </div>
    );
  }

  await act(async () => {
    render(
      <ComposeEmailProvider>
        <Probe />
      </ComposeEmailProvider>,
    );
  });
}

describe("ComposeEmailProvider shell requests (CAR-229)", () => {
  it("waits for capabilities before counting, then asks the free endpoint exactly once", async () => {
    await renderProvider();

    // Land the connection FIRST — the state that used to be the whole trigger.
    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));

    // Capabilities are still in flight, so no count has been attempted on
    // either endpoint. Without the gate, `isFreeOutreach` reads false here and
    // the badge fires against /api/gmail/unread.
    expect(http.countOf(UNREAD)).toBe(0);
    expect(http.countOf(AWAITING_REVIEW)).toBe(0);

    await act(async () => http.settle(CAPABILITIES, { capabilities: ["outreach:portal"] }));

    await waitFor(() => expect(http.countOf(AWAITING_REVIEW)).toBe(1));
    // Sequenced after the causal event, so this is not a vacuous absence.
    expect(http.countOf(UNREAD)).toBe(0);

    await act(async () => http.settle(AWAITING_REVIEW, { count: 4 }));
    await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("4"));
  });

  it("asks the premium endpoint exactly once for a premium user", async () => {
    await renderProvider();

    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));
    expect(http.countOf(UNREAD)).toBe(0);

    await act(async () => http.settle(CAPABILITIES, { capabilities: ["inbox:premium", "mailbox:read"] }));

    await waitFor(() => expect(http.countOf(UNREAD)).toBe(1));
    expect(http.countOf(AWAITING_REVIEW)).toBe(0);
  });

  it("reads gmail_connections exactly once for the whole shell", async () => {
    await renderProvider();

    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));
    await act(async () => http.settle(CAPABILITIES, { capabilities: ["outreach:portal"] }));
    await waitFor(() => expect(http.countOf(AWAITING_REVIEW)).toBe(1));
    await act(async () => http.settle(AWAITING_REVIEW, { count: 0 }));

    // Three requests, no more: the shared connection store, capabilities, and
    // one badge count. A reinstated private read would show up here either as a
    // second GET /api/gmail/connection or as a PostgREST /rest/v1/... call.
    expect(http.countOf(CONNECTION)).toBe(1);
    expect([...http.calls].sort()).toEqual([AWAITING_REVIEW, CAPABILITIES, CONNECTION].sort());
  });

  it("serves gmailConnected and gmailAddress from the shared store", async () => {
    await renderProvider();

    expect(screen.getByTestId("loading").textContent).toBe("true");

    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));
    await act(async () => http.settle(CAPABILITIES, { capabilities: ["outreach:portal"] }));

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("connected").textContent).toBe("true");
    expect(screen.getByTestId("address").textContent).toBe("me@gmail.com");
    expect(screen.getByTestId("free").textContent).toBe("true");
  });

  it("counts nothing when there is no connection row", async () => {
    await renderProvider();

    await act(async () => http.settle(CONNECTION, { connection: null }));
    await act(async () => http.settle(CAPABILITIES, { capabilities: [] }));

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(http.countOf(UNREAD)).toBe(0);
    expect(http.countOf(AWAITING_REVIEW)).toBe(0);
    expect(screen.getByTestId("connected").textContent).toBe("false");
  });

  it("does not re-count when the connection store refreshes with the same row", async () => {
    // The onboarding step polls refresh() every 3s. The store hands back a
    // fresh object each time, so a badge keyed on the row itself would issue a
    // count on every tick for the whole step.
    await renderProvider();

    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));
    await act(async () => http.settle(CAPABILITIES, { capabilities: ["outreach:portal"] }));
    await waitFor(() => expect(http.countOf(AWAITING_REVIEW)).toBe(1));
    await act(async () => http.settle(AWAITING_REVIEW, { count: 2 }));

    const { useGmailConnection } = await import("@/hooks/use-gmail-connection");
    let refresh!: () => Promise<void>;
    function RefreshProbe() {
      refresh = useGmailConnection().refresh;
      return null;
    }
    await act(async () => {
      render(<RefreshProbe />);
    });

    await act(async () => {
      void refresh();
    });
    await act(async () => http.settle(CONNECTION, CONNECTION_ROW));

    await waitFor(() => expect(http.countOf(CONNECTION)).toBe(2));
    expect(http.countOf(AWAITING_REVIEW)).toBe(1);
  });
});
