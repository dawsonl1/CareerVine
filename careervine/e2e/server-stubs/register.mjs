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
 *
 * HOW A DENIAL FAILS THE RUN (CAR-196): every denial is appended to the shared
 * log at `E2E_STUB_LOG`, which the `networkGuard` fixture asserts is empty for
 * the window of each test. Until CAR-196 denials were only printed, which
 * produced a real false green: CI run 30139719644 emitted four denied Gmail
 * `labels` calls and still reported `5 passed`.
 *
 * A file, not a listener: `NODE_OPTIONS=--import` arms this module in EVERY Node
 * process the webServer command starts — eleven of them for a single
 * `next build`, several of which evaluate route modules — so no one process can
 * own the channel. See `e2e/helpers/ports.ts` for the measurement.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { setupServer } from "msw/node";
import { http as mswHttp, HttpResponse, passthrough } from "msw";
import {
  gmailSendResponse,
  oauthTokenResponse,
  gmailListResponse,
  gmailLabelsResponse,
  gmailSendAsResponse,
  gmailMessageResponse,
  gmailModifyResponse,
  gmailThreadResponse,
  gmailDraftResponse,
  calendarEventsResponse,
  calendarEventResponse,
  calendarListResponse,
  calendarFreeBusyResponse,
  calendarSettingsResponse,
} from "../fixtures/google-wire.mjs";
import {
  openAiChatResponse,
  openAiResponsesResponse,
  deepgramProjectsResponse,
  deepgramTranscribeResponse,
  apifyRunResponse,
  apifyDatasetItemsResponse,
  resendSendResponse,
  serperNewsResponse,
  serperSearchResponse,
  upstashPipelineResponse,
} from "../fixtures/third-party-wire.mjs";

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
 * Where denials are recorded. Required, and checked at arm time for the same
 * reason `assertLocalSupabase` is: a stub layer that cannot report is worse than
 * one that is not running, because it looks like one that found nothing. Falling
 * back to log-only here would rebuild the exact blind spot CAR-196 closed.
 */
const logPath = process.env.E2E_STUB_LOG;
if (!logPath) {
  throw new Error(
    "[e2e-stubs] E2E_STUB_LOG is unset — refusing to arm. Denials would be printed but " +
      "never asserted, which is the false green this layer exists to prevent. " +
      "playwright.config.ts sets it in the webServer env.",
  );
}

/**
 * Prove, at arm time, that denials can actually be recorded — and leave a
 * receipt saying this server armed at all.
 *
 * Both halves close a silent-failure path. Without the write probe, a
 * permissions or disk error would first surface at the moment a denial needed
 * recording, where `recordDenial` can only `console.error` and the run still
 * reads green. Without the receipt, a server that never armed is
 * indistinguishable from a clean run — see `STUB_ARMED_PATH` in
 * `e2e/helpers/ports.ts` for the path that reaches that state routinely.
 *
 * Every process the webServer command starts runs this (eleven of them for one
 * `next build`); the writes are idempotent, so that is harmless.
 */
const armedPath = process.env.E2E_STUB_ARMED;
try {
  fs.mkdirSync(nodePath.dirname(logPath), { recursive: true });
  // Creates the file if absent, appends nothing: a pure writability probe.
  fs.appendFileSync(logPath, "");
  if (armedPath) fs.writeFileSync(armedPath, `armed pid ${process.pid}\n`);
} catch (err) {
  throw new Error(
    `[e2e-stubs] cannot write the denial log at ${logPath} — refusing to arm, because ` +
      "denials would be silently unrecorded and the run would read green. " +
      `Underlying error: ${err.message}`,
  );
}

/**
 * Record one denied call in the shared log.
 *
 * Append-only and one line per call, so the Playwright side can slice by index:
 * each test asserts on its own window and one spec's denial is never charged to
 * the next. Recording never throws: an exception raised inside an MSW handler
 * would surface as a confusing upstream error in whatever route happened to make
 * the call, burying the denial it was trying to report.
 */
function recordDenial(call) {
  const line = `${call}\n`;
  try {
    fs.appendFileSync(logPath, line);
    return;
  } catch (err) {
    // The log lives under test-results/, which Playwright owns and clears. Make
    // the directory rather than losing the record that a denial happened.
    if (err?.code !== "ENOENT") {
      console.error(`[e2e-stubs] could not append to ${logPath}:`, err);
      return;
    }
  }
  try {
    fs.mkdirSync(nodePath.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error(`[e2e-stubs] could not append to ${logPath}:`, err);
  }
}

/**
 * Origin the Upstash rate-limit stub answers on; see the allowlist's rationale.
 *
 * Gated on the `.invalid` TLD, and that gate is the whole point. The host is
 * read from `UPSTASH_REDIS_REST_URL`, so without it a real Upstash URL leaking
 * in from a developer's `.env.local` would have a handler built FOR it — the
 * one path the limiter uses would be answered silently instead of being denied
 * by name. RFC 6761 guarantees `.invalid` never resolves, so a handler can only
 * ever be built for a host that provably is not a real service; anything else
 * falls through to the catch-all and names itself.
 */
const upstashHost = (() => {
  try {
    const host = new URL(process.env.UPSTASH_REDIS_REST_URL ?? "").host;
    return host.endsWith(".invalid") ? host : "";
  } catch {
    return "";
  }
})();

const server = setupServer(
  // ── Gmail ──────────────────────────────────────────────────────────────
  mswHttp.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/send", () =>
    HttpResponse.json(gmailSendResponse()),
  ),
  mswHttp.get("https://gmail.googleapis.com/gmail/v1/users/:userId/messages", () =>
    HttpResponse.json(gmailListResponse()),
  ),
  mswHttp.get("https://gmail.googleapis.com/gmail/v1/users/:userId/settings/sendAs", () =>
    HttpResponse.json(gmailSendAsResponse()),
  ),
  // Added after the first CI run denied it four times during the compose flow —
  // exactly the signal this layer exists to produce. Without it the inbox
  // renders against a 599 and the tier quietly tests a degraded app.
  mswHttp.get("https://gmail.googleapis.com/gmail/v1/users/:userId/labels", () =>
    HttpResponse.json(gmailLabelsResponse()),
  ),
  // The mutating half of the inbox (CAR-196), for CAR-191's read/trash/restore
  // and move-to-folder flows. Order among these is free: MSW compiles paths with
  // path-to-regexp `end: true`, so `/messages` does not match `/messages/abc`
  // (measured). The catch-all's position is the file's only real ordering
  // constraint, and it is called out where it matters, at the bottom.
  mswHttp.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/:id/modify", () =>
    HttpResponse.json(gmailModifyResponse()),
  ),
  mswHttp.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/:id/trash", () =>
    HttpResponse.json(gmailModifyResponse({ labelIds: ["TRASH"] })),
  ),
  mswHttp.post("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/:id/untrash", () =>
    HttpResponse.json(gmailModifyResponse()),
  ),
  mswHttp.get("https://gmail.googleapis.com/gmail/v1/users/:userId/messages/:id", ({ params }) =>
    HttpResponse.json(gmailMessageResponse({ id: params.id })),
  ),
  mswHttp.get("https://gmail.googleapis.com/gmail/v1/users/:userId/threads/:id", ({ params }) =>
    HttpResponse.json(gmailThreadResponse({ id: params.id })),
  ),
  mswHttp.post("https://gmail.googleapis.com/gmail/v1/users/:userId/drafts", () =>
    HttpResponse.json(gmailDraftResponse()),
  ),

  // ── Google OAuth token refresh ─────────────────────────────────────────
  mswHttp.post("https://oauth2.googleapis.com/token", () =>
    HttpResponse.json(oauthTokenResponse()),
  ),

  // ── Calendar ───────────────────────────────────────────────────────────
  mswHttp.get("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events", () =>
    HttpResponse.json(calendarEventsResponse()),
  ),
  mswHttp.post("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events", () =>
    HttpResponse.json(calendarEventResponse()),
  ),
  mswHttp.get("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/:eventId", () =>
    HttpResponse.json(calendarEventResponse()),
  ),
  mswHttp.put("https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/:eventId", () =>
    HttpResponse.json(calendarEventResponse()),
  ),
  mswHttp.delete(
    "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/:eventId",
    () => new HttpResponse(null, { status: 204 }),
  ),
  mswHttp.get("https://www.googleapis.com/calendar/v3/users/me/calendarList", () =>
    HttpResponse.json(calendarListResponse()),
  ),
  mswHttp.post("https://www.googleapis.com/calendar/v3/freeBusy", () =>
    HttpResponse.json(calendarFreeBusyResponse()),
  ),
  mswHttp.get("https://www.googleapis.com/calendar/v3/users/me/settings/:setting", () =>
    HttpResponse.json(calendarSettingsResponse()),
  ),

  // ── OpenAI ─────────────────────────────────────────────────────────────
  // BOTH APIs, because the app uses both: chat/completions from five sites under
  // src/lib/ai-followup/, and the Responses API from the transcript routes, the
  // extension profile parser and the BYOK key-save validator. Several ask for
  // strict JSON and then parse the result, so the default body is valid JSON —
  // prose would throw before the route under test ever ran.
  mswHttp.post("https://api.openai.com/v1/chat/completions", () =>
    HttpResponse.json(openAiChatResponse({ content: "{}" })),
  ),
  mswHttp.post("https://api.openai.com/v1/responses", () =>
    HttpResponse.json(openAiResponsesResponse({ text: "{}" })),
  ),

  // ── Deepgram ───────────────────────────────────────────────────────────
  // `/v1/projects` is the BYOK key-validation probe (status only); `/v1/listen`
  // is the actual transcription call.
  mswHttp.get("https://api.deepgram.com/v1/projects", () =>
    HttpResponse.json(deepgramProjectsResponse()),
  ),
  mswHttp.post("https://api.deepgram.com/v1/listen", () =>
    HttpResponse.json(deepgramTranscribeResponse()),
  ),

  // ── Apify (LinkedIn scrape) ────────────────────────────────────────────
  mswHttp.post("https://api.apify.com/v2/acts/*/runs", () =>
    HttpResponse.json(apifyRunResponse()),
  ),
  mswHttp.post("https://api.apify.com/v2/acts/*/run-sync-get-dataset-items", () =>
    HttpResponse.json(apifyDatasetItemsResponse()),
  ),
  mswHttp.get("https://api.apify.com/v2/actor-runs/:runId", () =>
    HttpResponse.json(apifyRunResponse()),
  ),
  mswHttp.get("https://api.apify.com/v2/datasets/:datasetId/items", () =>
    HttpResponse.json(apifyDatasetItemsResponse()),
  ),

  // ── Resend ─────────────────────────────────────────────────────────────
  mswHttp.post("https://api.resend.com/emails", () => HttpResponse.json(resendSendResponse())),

  // ── Serper ─────────────────────────────────────────────────────────────
  mswHttp.post("https://google.serper.dev/news", () => HttpResponse.json(serperNewsResponse())),
  mswHttp.post("https://google.serper.dev/search", () => HttpResponse.json(serperSearchResponse())),

  // ── Upstash (rate limiting) ────────────────────────────────────────────
  // Scoped to a `.invalid` host, so a stray real Upstash URL from a developer's
  // .env.local gets no handler at all and lands in the catch-all by name.
  ...(upstashHost
    ? [
        mswHttp.post(`https://${upstashHost}/pipeline`, async ({ request }) =>
          HttpResponse.json(upstashPipelineResponse(await request.json())),
        ),
      ]
    : []),

  // ── Deny-by-default catch-all. MUST stay last: MSW matches in order. ────
  mswHttp.all("*", ({ request }) => {
    const url = new URL(request.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return passthrough();

    const call = `${request.method} ${url.origin}${url.pathname}`;
    recordDenial(call);
    // Surfaced in the server log, and captured in Playwright's webServer output
    // on failure, so a new unstubbed dependency names itself. The assertion that
    // actually fails the test reads the same call out of the shared log.
    console.error(`[e2e-stubs] DENIED ${call} — add a handler in e2e/server-stubs/register.mjs`);
    return HttpResponse.json(
      { error: `e2e: unstubbed external call to ${call}` },
      // 418, not a 5xx, and the difference is load-bearing (CAR-196 review).
      //
      // This was 599 — implausible enough to never be mistaken for a real
      // upstream response, which was the right instinct and the wrong number.
      // `withRetry` in src/lib/gmail.ts treats `status >= 500 && status < 600`
      // as retryable, so every unstubbed Gmail call became FOUR denials spread
      // over ~8 seconds of backoff. That quadrupled the noise in the one signal
      // that has to stay readable, and it stretched a denial's arrival window
      // far enough to routinely straddle a test boundary, where it lands in the
      // next test's window and blames an innocent spec.
      //
      // 418 keeps the "obviously not a real upstream" property (no service in
      // this app's dependency graph returns it) while being outside every
      // client's retry band: gmail.ts retries 429 and 5xx, the OpenAI SDK
      // 408/409/429/5xx. So a miss now fails once, immediately, and by name.
      { status: 418 },
    );
  }),
);

server.listen();

// The arming receipt, visible in Playwright's webServer output and in CI logs.
// Expect several — one per Node process the webServer command starts.
console.log(
  `[e2e-stubs] armed (pid ${process.pid}); external origins deny-by-default; denials → ${logPath}`,
);
