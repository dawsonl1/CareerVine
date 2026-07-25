/**
 * Routed `fetch` double that answers with REAL `Response` objects (CAR-183).
 *
 * ── Why a real Response and not the usual object literal ─────────────────
 *
 * The established idiom in this suite is a hand-rolled stub:
 *
 *   global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
 *     as unknown as typeof fetch;
 *
 * That cast is load-bearing, which is the tell: the literal is not a Response
 * and nothing typechecks it against one. It usually carries no `status`, so
 * `res.status` reads `undefined`. That was survivable while call sites only
 * branched on `res.ok`, and stops being survivable now that mutations go
 * through `apiSend` (`src/lib/api-client.ts`): its failure path reads
 * `res.status` AND `await res.json()` to build the `ApiRequestError` that
 * carries the route's curated message. Asserted against a hand-rolled stub,
 * a test proves the stub.
 *
 * The jsdom environment supplies undici's `Response` as a global (verified,
 * not assumed), so a fixture can be the real thing and `ok` / `status` /
 * `json()` behave exactly as they do in the browser.
 *
 * ── Why routed, and why an unrouted call is an error ─────────────────────
 *
 * A catch-all fake that answers every URL with `{}` lets a component fetch
 * the WRONG endpoint and still pass. Routes are declared per `"METHOD /url"`,
 * an unrouted request throws a named error, and `unmatched` records it so the
 * miss is visible even when the component under test swallows the rejection.
 *
 * Installed through `vi.stubGlobal`, so `vi.unstubAllGlobals()` restores the
 * real `fetch`; a direct `global.fetch =` assignment leaks the stub into every
 * later file sharing the worker.
 *
 *   const http = installFakeFetch({
 *     "GET /api/things": { body: { things: [] } },
 *     "DELETE /api/things/7": { status: 404, body: { error: "Not found" } },
 *   });
 *   // ...exercise the component...
 *   expect(http.countOf("DELETE /api/things/7")).toBe(1);
 *
 * Pair with `afterEach(() => vi.unstubAllGlobals())`.
 */
import { vi } from "vitest";

export interface FakeRoute {
  /** HTTP status of the answer. Defaults to 200. */
  status?: number;
  /** Value JSON-serialized as the response body. Omit for an empty body. */
  body?: unknown;
  /**
   * Reject the fetch outright instead of answering, simulating a dropped
   * connection. Distinct from a non-2xx: this is the only failure the old
   * bare `try/catch` idiom could actually observe.
   */
  reject?: Error;
}

/** Routes keyed by `"METHOD /url"`, e.g. `"DELETE /api/gmail/templates/3"`. */
export type FakeRoutes = Record<string, FakeRoute>;

export interface FakeFetch {
  /** Every `"METHOD /url"` issued, in order. */
  readonly calls: string[];
  /** Requests with no declared route. Non-empty means an unexpected URL. */
  readonly unmatched: string[];
  /** How many times one `"METHOD /url"` was issued. */
  countOf(key: string): number;
}

function requestKey(input: RequestInfo | URL, init?: RequestInit): string {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return `${method} ${url}`;
}

/**
 * Stub the global `fetch` with a router over `routes`. Returns a handle for
 * asserting which requests the component actually issued.
 */
export function installFakeFetch(routes: FakeRoutes): FakeFetch {
  const calls: string[] = [];
  const unmatched: string[] = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = requestKey(input, init);
    calls.push(key);

    const route = routes[key];
    if (!route) {
      unmatched.push(key);
      const declared = Object.keys(routes);
      throw new Error(
        `installFakeFetch: no route for "${key}". Declared: ${declared.length ? declared.join(", ") : "(none)"}`,
      );
    }

    if (route.reject) throw route.reject;

    const status = route.status ?? 200;
    // 204/205/304 must carry a null body or the Response constructor throws,
    // so an omitted body stays null rather than becoming the string "undefined".
    const body = route.body === undefined ? null : JSON.stringify(route.body);
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  vi.stubGlobal("fetch", vi.fn(impl));

  return {
    calls,
    unmatched,
    countOf: (key: string) => calls.filter((c) => c === key).length,
  };
}
