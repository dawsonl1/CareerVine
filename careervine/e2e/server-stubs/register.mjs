/**
 * Server-side third-party interception for the E2E tier (CAR-189).
 *
 * Loaded into the Next server process by `playwright.config.ts`'s webServer
 * block as `NODE_OPTIONS=--import ./e2e/server-stubs/register.mjs`, so it is
 * armed before Next loads a single route module.
 *
 * WHY THIS EXISTS AT ALL, rather than `page.route()`:
 * the calls this tier must control are made by the **server**, not the browser.
 * `POST /api/gmail/send` reaches Google from inside the Next process
 * (`src/lib/gmail-send-core.ts` → `@googleapis/gmail`). `page.route()` cannot
 * see that. Stubbing the browser hop to `/api/gmail/send` instead would skip
 * every server-side database write — which is precisely what this tier exists
 * to assert.
 *
 * WHY MSW rather than an undici dispatcher: `@googleapis/*` resolves its HTTP
 * client through gaxios, which uses **node-fetch v3**, not undici. So
 * `setGlobalDispatcher` misses Gmail entirely. MSW patches `http.ClientRequest`
 * *and* global `fetch`, which covers node-fetch, undici, and raw
 * `https.request` alike. Verified against all three before this was written.
 *
 * WHY THE TRAILING CATCH-ALL: MSW's `onUnhandledRequest: 'error'` only *prints*
 * an error — the request still goes out. Measured: unstubbed calls reached the
 * real api.resend.com / api.openai.com / api.apify.com and came back 401. A
 * trailing `http.all('*')` handler is what actually blocks them.
 *
 * The blocking is also a SAFETY PROPERTY, not just determinism. Because every
 * non-loopback origin is denied, this server process cannot reach
 * `*.supabase.co` even if it were somehow built against production credentials
 * — the same structural guarantee CAR-178's loopback check gives the
 * integration tier.
 */
import { setupServer } from "msw/node";
import { http, HttpResponse, passthrough } from "msw";
import {
  gmailSendResponse,
  oauthTokenResponse,
  gmailListResponse,
  gmailLabelsResponse,
  gmailSendAsResponse,
  calendarEventsResponse,
} from "../fixtures/google-wire.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/** Refuse to arm against anything but a local stack. Fails the run, loudly. */
function assertLocalSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error("[e2e-stubs] NEXT_PUBLIC_SUPABASE_URL is unset — refusing to start.");
  }
  const host = new URL(url).hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[e2e-stubs] NEXT_PUBLIC_SUPABASE_URL points at ${host}, not loopback. ` +
        "Refusing to start an E2E server against a remote database.",
    );
  }
}

assertLocalSupabase();

/**
 * Anything a test needs to observe about outbound calls. The tests read it back
 * over `GET /__e2e__/stub-calls` — see below.
 */
const denied = [];

const server = setupServer(
  // ── Gmail ──────────────────────────────────────────────────────────────
  http.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/send", () =>
    HttpResponse.json(gmailSendResponse()),
  ),
  http.get("https://gmail.googleapis.com/gmail/v1/users/:userId/messages", () =>
    HttpResponse.json(gmailListResponse()),
  ),
  http.get("https://gmail.googleapis.com/gmail/v1/users/:userId/settings/sendAs", () =>
    HttpResponse.json(gmailSendAsResponse()),
  ),
  // Added after the first CI run denied it four times during the compose flow —
  // exactly the signal this layer exists to produce. Without it the inbox
  // renders against a 599 and the tier quietly tests a degraded app.
  http.get("https://gmail.googleapis.com/gmail/v1/users/:userId/labels", () =>
    HttpResponse.json(gmailLabelsResponse()),
  ),

  // ── Google OAuth token refresh ─────────────────────────────────────────
  http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json(oauthTokenResponse())),

  // ── Calendar ───────────────────────────────────────────────────────────
  http.get("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events", () =>
    HttpResponse.json(calendarEventsResponse()),
  ),

  // ── Deny-by-default catch-all. MUST stay last: MSW matches in order. ────
  http.all("*", ({ request }) => {
    const url = new URL(request.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return passthrough();

    const call = `${request.method} ${url.origin}${url.pathname}`;
    denied.push(call);
    // Surfaced in the server log, and captured in Playwright's webServer output
    // on failure, so a new unstubbed dependency names itself.
    console.error(`[e2e-stubs] DENIED ${call} — add a handler in e2e/server-stubs/register.mjs`);
    return HttpResponse.json(
      { error: `e2e: unstubbed external call to ${call}` },
      // 599 rather than a plausible 4xx/5xx so it can never be mistaken for a
      // real upstream response in a test's assertion.
      { status: 599 },
    );
  }),
);

server.listen();

// The arming receipt, visible in Playwright's webServer output and in CI logs.
console.log(`[e2e-stubs] armed (pid ${process.pid}); external origins deny-by-default`);

process.on("exit", () => {
  if (denied.length) {
    console.error(`[e2e-stubs] ${denied.length} denied external call(s):`);
    for (const c of [...new Set(denied)]) console.error(`  - ${c}`);
  }
});
