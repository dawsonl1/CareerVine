/**
 * Routed `fetch` double that answers with REAL `Response` objects (CAR-183).
 *
 * A test that exercises an HTTP call installs this instead of assigning its own
 * double to `global.fetch`. Routes are keyed `"METHOD /url"`; the return handle
 * is how the test asserts which requests were actually issued.
 *
 * ── Why a real Response and not the usual object literal ─────────────────
 *
 * The established idiom in this suite is a hand-rolled stub:
 *
 *   global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
 *     as unknown as typeof fetch;
 *
 * That cast is load-bearing, which is the tell: the literal is not a Response
 * and nothing typechecks it against one. Most instances carry no `status` (a
 * few, like calendar-page.test.tsx, do), so `res.status` commonly reads
 * `undefined`. That was survivable while call sites only branched on `res.ok`,
 * and stops being survivable now that mutations go through `apiSend`
 * (`src/lib/api-client.ts`): its failure path reads `res.status` AND
 * `await res.json()` to build the `ApiRequestError` that carries the route's
 * curated message. Asserted against a hand-rolled stub, a test proves the stub.
 *
 * `Response` here is Node's undici class, not jsdom's — jsdom defines no
 * `Response` at all. Vitest's jsdom environment only overrides the globals in
 * its own key list, which `Response` and `fetch` are not on, so Node's survive
 * and `ok` / `status` / `json()` behave exactly as they do in the browser.
 *
 * ── Why routed, and why an unrouted call is an error ─────────────────────
 *
 * A catch-all fake that answers every URL with `{}` lets a component fetch
 * the WRONG endpoint and still pass. Routes are declared per `"METHOD /url"`,
 * and an unrouted request throws AND is recorded in `unmatched`.
 *
 * That throw alone is NOT a loud failure: the handlers this helper exists to
 * test swallow rejections (a bare `.catch(() => {})`, or `withToastOnError`),
 * so a miss can masquerade as the failure the test was written for. `unmatched`
 * exists for exactly that reason — every test asserts it is empty, or asserts
 * `countOf` on the route it injected, so a wrong endpoint cannot pass silently.
 *
 * Installed through `vi.stubGlobal`, so `vi.unstubAllGlobals()` restores the
 * real `fetch`. Vitest isolates modules per file by default, so a bare
 * `global.fetch =` assignment does not leak across files, but it does leak
 * across tests WITHIN a file, which is enough reason to prefer the stub.
 *
 *   const http = installFakeFetch({
 *     "GET /api/things": { body: { things: [] } },
 *     "DELETE /api/things/7": { status: 404, body: { error: "Not found" } },
 *   });
 *   // ...exercise the component...
 *   expect(http.countOf("DELETE /api/things/7")).toBe(1);
 *   expect(http.unmatched).toEqual([]);
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
  /**
   * Hold the answer until this settles, so a test can land responses OUT OF
   * ORDER (CAR-249). Required to exercise a `useLatestRequest` gate at all: the
   * bug it guards is a slower request for an identity the user already
   * navigated away from overwriting the newer one (CAR-145 / F19), and without
   * a way to stall one route, every response resolves in issue order and the
   * gate is never actually tested.
   *
   *   let release: () => void;
   *   installFakeFetch({
   *     "GET /a": { body: {...}, delay: new Promise<void>(r => { release = r }) },
   *     "GET /b": { body: {...} },
   *   });
   */
  delay?: Promise<void>;
}

/** Routes keyed by `"METHOD /url"`, e.g. `"DELETE /api/gmail/templates/3"`. */
export type FakeRoutes = Record<string, FakeRoute>;

/** One captured request, so a test can assert on more than the URL. */
export interface RecordedRequest {
  /** The `"METHOD /url"` routing key. */
  key: string;
  method: string;
  /** Path plus query, normalized (never the origin). */
  url: string;
  init?: RequestInit;
}

export interface FakeFetch {
  /** Every `"METHOD /url"` issued, in order. */
  readonly calls: string[];
  /** The same requests with their init, for asserting headers and payloads. */
  readonly requests: RecordedRequest[];
  /** Requests with no declared route. Non-empty means an unexpected URL. */
  readonly unmatched: string[];
  /** How many times one `"METHOD /url"` was issued. */
  countOf(key: string): number;
  /**
   * The parsed JSON body of the last request matching `key`, for asserting
   * what a mutation actually sent. Undefined when the request carried no body.
   */
  bodyOf(key: string): unknown;
}

/**
 * Only ever used to resolve a relative URL so `pathname`/`search` can be read
 * back. `Request.url` and `URL.toString()` are always absolute, so without
 * this a caller passing either could never match a `"METHOD /path"` route.
 */
const RELATIVE_BASE = "http://localhost";

function normalizeUrl(raw: string): string {
  const parsed = new URL(raw, RELATIVE_BASE);
  return `${parsed.pathname}${parsed.search}`;
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): RecordedRequest {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const url = normalizeUrl(raw);
  return { key: `${method} ${url}`, method, url, init };
}

/**
 * Stub the global `fetch` with a router over `routes`. Returns a handle for
 * asserting which requests the component actually issued.
 */
export function installFakeFetch(routes: FakeRoutes): FakeFetch {
  const calls: string[] = [];
  const requests: RecordedRequest[] = [];
  const unmatched: string[] = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const record = describeRequest(input, init);
    calls.push(record.key);
    requests.push(record);

    const route = routes[record.key];
    if (!route) {
      unmatched.push(record.key);
      const declared = Object.keys(routes);
      throw new Error(
        `installFakeFetch: no route for "${record.key}". Declared: ${declared.length ? declared.join(", ") : "(none)"}`,
      );
    }

    // Awaited AFTER recording the call, so `calls` reflects issue order even
    // when the answers land in a different one.
    if (route.delay) await route.delay;

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
    requests,
    unmatched,
    countOf: (key: string) => calls.filter((c) => c === key).length,
    bodyOf: (key: string) => {
      const last = [...requests].reverse().find((r) => r.key === key);
      const raw = last?.init?.body;
      return typeof raw === "string" ? JSON.parse(raw) : undefined;
    },
  };
}
