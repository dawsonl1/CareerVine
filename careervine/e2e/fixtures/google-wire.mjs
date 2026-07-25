/**
 * Google API **wire** payloads for the E2E tier (CAR-189).
 *
 * Why this is not sourced from `src/__tests__/helpers/fake-gmail.ts`, as the
 * ticket originally asked: that helper is a *client-object* double. It fakes
 * the `@googleapis/gmail` client's `messages.list` / `messages.get` methods —
 * the object the app calls, not the HTTP body Google returns. Nothing in it can
 * be handed to `route.fulfill()` or `HttpResponse.json()`.
 *
 * So the wire bodies live here, once, and `e2e/server-stubs/register.mjs`
 * imports them into the MSW handlers running inside the Next server process —
 * which is where every Google call in this app is actually made. The browser-side
 * guard in `e2e/fixtures/test.ts` does not import this module and has no reason
 * to: it denies rather than fulfils, because no Google traffic originates in the
 * page. (An earlier version of this header claimed a second importer,
 * `e2e/helpers/network.ts`, that was never committed — CAR-196.)
 *
 * Non-Google vendors live in the sibling `third-party-wire.mjs`.
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

/**
 * Response body of `gmail.users.messages.get`.
 *
 * Two consumers, and they read different things. `syncEmailsForContact`
 * (src/lib/gmail.ts) requests `format: "metadata"` and reads `payload.headers`
 * (as `{name, value}` pairs), `labelIds`, `snippet` and `internalDate`.
 * `getFullMessage` requests `format: "full"` and additionally walks
 * `payload.body.data` as base64url. The default below carries all of it.
 *
 * It carries a `text/plain` body only, so `getFullMessage`'s `bodyHtml` is
 * always null in this tier — fine for both current callers, but pass a richer
 * payload rather than assuming the HTML branch is covered.
 */
export function gmailMessageResponse({
  id = SENT_MESSAGE_ID,
  threadId = SENT_THREAD_ID,
  from = "E2E Sender <e2e-sender@gmail.com>",
  to = "e2e-contact@example.com",
  subject = "E2E stub message",
  body = "E2E stub body.",
  labelIds = ["INBOX"],
  internalDate = "1767225600000",
} = {}) {
  return {
    id,
    threadId,
    labelIds,
    snippet: body.slice(0, 100),
    internalDate,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
        { name: "Date", value: new Date(Number(internalDate)).toUTCString() },
        { name: "Message-ID", value: `<${id}@mail.gmail.com>` },
      ],
      body: { size: body.length, data: Buffer.from(body, "utf8").toString("base64url") },
    },
    sizeEstimate: body.length,
  };
}

/**
 * Response body of `messages.modify` / `.trash` / `.untrash` — each returns the
 * updated message resource. `labelIds` is the only field the callers act on, so
 * it is the only one worth varying.
 */
export function gmailModifyResponse({ id = SENT_MESSAGE_ID, labelIds = ["INBOX"] } = {}) {
  return { id, threadId: SENT_THREAD_ID, labelIds };
}

/** Response body of `gmail.users.threads.get`. */
export function gmailThreadResponse({ id = SENT_THREAD_ID, messages } = {}) {
  return { id, historyId: "1", messages: messages ?? [gmailMessageResponse()] };
}

/** Response body of `gmail.users.drafts.create`. */
export function gmailDraftResponse({ id = "e2e-gmail-draft-0001" } = {}) {
  return { id, message: gmailModifyResponse({ labelIds: ["DRAFT"] }) };
}

/** Response body of `calendar.events.list` — empty by default. */
export function calendarEventsResponse({ items = [], nextSyncToken = "e2e-sync-token" } = {}) {
  return { kind: "calendar#events", items, nextSyncToken };
}

/** Response body of a single-event `calendar.events.{get,insert,update}`. */
export function calendarEventResponse({
  id = "e2e-calendar-event-0001",
  summary = "E2E stub event",
  start = "2026-01-01T17:00:00Z",
  end = "2026-01-01T17:30:00Z",
} = {}) {
  return {
    kind: "calendar#event",
    id,
    status: "confirmed",
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: [],
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
  };
}

/** Response body of `calendar.calendarList.list`. */
export function calendarListResponse(ids = ["e2e@gmail.com"]) {
  return {
    kind: "calendar#calendarList",
    items: ids.map((id, i) => ({ id, summary: id, primary: i === 0, accessRole: "owner" })),
  };
}

/** Response body of `calendar.freebusy.query` — nothing busy by default. */
export function calendarFreeBusyResponse(calendars = { "e2e@gmail.com": { busy: [] } }) {
  return { kind: "calendar#freeBusy", calendars };
}

/** Response body of `calendar.settings.get` — the timezone setting. */
export function calendarSettingsResponse(value = "America/Denver") {
  return { kind: "calendar#setting", id: "timezone", value };
}
