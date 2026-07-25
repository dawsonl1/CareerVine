/**
 * Google API **wire** payloads for the E2E tier (CAR-189).
 *
 * Why this is not sourced from `src/__tests__/helpers/fake-gmail.ts`, as the
 * ticket originally asked: that helper is a *client-object* double. It fakes
 * the `@googleapis/gmail` client's `messages.list` / `messages.get` methods —
 * the object the app calls, not the HTTP body Google returns. Nothing in it can
 * be handed to `route.fulfill()` or `HttpResponse.json()`.
 *
 * So the wire bodies live here, once, and both interception layers import this
 * module:
 *   - `e2e/server-stubs/register.mjs` — MSW inside the Next server process,
 *     which is where the Google calls are actually made.
 *   - `e2e/helpers/network.ts` — `page.route()` for browser-side traffic.
 *
 * Plain `.mjs`, not `.ts`, on purpose: the server preload is loaded by raw Node
 * via `--import` before any TypeScript loader exists, and installing a loader
 * hook into the Next server process is risk this tier does not need. TypeScript
 * imports it happily (`allowJs`, bundler resolution).
 */

/** Stable ids so assertions can name the exact row the send should produce. */
export const SENT_MESSAGE_ID = "e2e-gmail-msg-0001";
export const SENT_THREAD_ID = "e2e-gmail-thread-0001";

/** Response body of `gmail.users.messages.send`. */
export function gmailSendResponse({
  id = SENT_MESSAGE_ID,
  threadId = SENT_THREAD_ID,
} = {}) {
  return { id, threadId, labelIds: ["SENT"] };
}

/** Response body of the OAuth2 token endpoint (refresh path). */
export function oauthTokenResponse() {
  return {
    access_token: "e2e-refreshed-access-token",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/gmail.send",
    token_type: "Bearer",
  };
}

/** Response body of `gmail.users.messages.list` — empty by default. */
export function gmailListResponse({ messages = [], nextPageToken = undefined } = {}) {
  return {
    messages,
    resultSizeEstimate: messages.length,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

/**
 * Response body of `gmail.users.labels.list`.
 *
 * `getGmailLabels` (src/lib/gmail.ts) keeps `type === "user"` plus a visible-system
 * allowlist, so the fixture carries one of each to exercise both legs of that filter.
 */
export function gmailLabelsResponse() {
  return {
    labels: [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
      { id: "Label_1", name: "Networking", type: "user" },
    ],
  };
}

/** Response body of `gmail.users.settings.sendAs.list`. */
export function gmailSendAsResponse(addresses = ["e2e@gmail.com"]) {
  return {
    sendAs: addresses.map((sendAsEmail, i) => ({
      sendAsEmail,
      isPrimary: i === 0,
      verificationStatus: "accepted",
    })),
  };
}

/** Response body of `calendar.events.list` — empty by default. */
export function calendarEventsResponse({ items = [], nextSyncToken = "e2e-sync-token" } = {}) {
  return { kind: "calendar#events", items, nextSyncToken };
}

/**
 * The origins this tier is allowed to talk to at all. Anything outside this set
 * AND outside loopback is denied — see the catch-all in server-stubs/register.mjs
 * and in helpers/network.ts.
 */
export const STUBBED_ORIGINS = [
  "https://gmail.googleapis.com",
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
  "https://accounts.google.com",
  "https://api.openai.com",
  "https://api.resend.com",
  "https://api.apify.com",
];
