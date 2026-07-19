/**
 * CAR-152: drives the REAL fetchCalendarEvents pagination loop and the REAL
 * sync-route batching. Only the Google client factory, OAuth helpers, and
 * Supabase clients are faked — row construction, attribution, upserts, and
 * cancellation deletes all run production code.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  createFakeCalendarApi,
  makeEvent,
  makeAllDayEvent,
  makeRecurringInstance,
  makeCancelledInstance,
  type FakeCalendarApi,
} from "./helpers/fake-calendar";

let fakeApi: FakeCalendarApi;

vi.mock("@googleapis/calendar", () => ({
  calendar: () => fakeApi,
}));

vi.mock("@/lib/oauth-helpers", () => ({
  getOAuth2Client: () => ({ setCredentials: vi.fn() }),
  refreshTokenIfNeeded: vi.fn(async () => {}),
  decryptOAuthToken: (v: string) => v,
  encryptOAuthToken: (v: string) => v,
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }),
}));

// ── recording fake Supabase service client ──

const state = {
  connection: {
    calendar_scopes_granted: true,
    calendar_last_synced_at: "2026-07-09T11:00:00.000Z" as string | null,
    calendar_sync_token: null as string | null,
    gmail_address: "me@example.com",
    // token columns read by getCalendarClient
    access_token: "at",
    refresh_token: "rt",
    token_expires_at: "2026-07-09T13:00:00.000Z",
  },
};

let fromCalls: string[] = [];
let gmailUpdates: Array<Record<string, unknown>> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test recorder mirrors the route's any-typed rows (CAR-142)
let eventUpsertBatches: any[][] = [];
let linkUpsertBatches: Array<Array<{ calendar_event_id: number; contact_id: number }>> = [];
let contactEmailQueries: Array<{ emails: string[]; scopeCol: string; scopeVal: unknown }> = [];
let contactEmailRows: Array<{ email: string; contact_id: number; user_id: string }> = [];
let deletedLinkEventIds: number[][] = [];
let deletedEventIds: number[][] = [];
let cancelledLookups: string[][] = [];
// When true, every calendar_events bulk upsert fails — drives the
// token-must-not-advance-on-partial-failure test.
let failEventUpserts = false;

// Deterministic numeric id per google_event_id, mimicking the bulk
// upsert's RETURNING rows.
let nextRowId = 100;
const rowIdByGoogleId = new Map<string, number>();
function idFor(googleId: string) {
  if (!rowIdByGoogleId.has(googleId)) rowIdByGoogleId.set(googleId, nextRowId++);
  return rowIdByGoogleId.get(googleId)!;
}

function createServiceClient() {
  return {
    from: (table: string) => {
      fromCalls.push(table);

      if (table === "gmail_connections") {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: state.connection, error: null }) }),
          }),
          update: (payload: Record<string, unknown>) => {
            gmailUpdates.push(payload);
            return { eq: async () => ({ error: null }) };
          },
        };
      }

      if (table === "calendar_events") {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test recorder mirrors the route's any-typed rows (CAR-142)
          upsert: (rows: any[], _opts: Record<string, unknown>) => {
            eventUpsertBatches.push(rows);
            return {
              select: async () =>
                failEventUpserts
                  ? { data: null, error: { message: "chunk failed" } }
                  : {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test recorder mirrors the route's any-typed rows (CAR-142)
                      data: rows.map((r: any) => ({
                        id: idFor(r.google_event_id),
                        google_event_id: r.google_event_id,
                      })),
                      error: null,
                    },
            };
          },
          select: () => ({
            eq: () => ({
              in: async (_col: string, googleIds: string[]) => {
                cancelledLookups.push(googleIds);
                return {
                  data: googleIds
                    .filter((g) => rowIdByGoogleId.has(g))
                    .map((g) => ({ id: idFor(g) })),
                  error: null,
                };
              },
            }),
          }),
          delete: () => ({
            in: async (_col: string, ids: number[]) => {
              deletedEventIds.push(ids);
              return { error: null };
            },
          }),
        };
      }

      if (table === "calendar_event_contacts") {
        return {
          upsert: async (
            rows: Array<{ calendar_event_id: number; contact_id: number }>,
            _opts: Record<string, unknown>
          ) => {
            linkUpsertBatches.push(rows);
            return { error: null };
          },
          delete: () => ({
            in: async (_col: string, ids: number[]) => {
              deletedLinkEventIds.push(ids);
              return { error: null };
            },
          }),
        };
      }

      if (table === "contact_emails") {
        return {
          select: () => ({
            in: (_col: string, emails: string[]) => ({
              eq: async (scopeCol: string, scopeVal: unknown) => {
                contactEmailQueries.push({ emails, scopeCol, scopeVal });
                const data = contactEmailRows
                  .filter((r) => emails.includes(r.email))
                  .filter((r) => r.user_id === scopeVal)
                  .map((r) => ({
                    contact_id: r.contact_id,
                    email: r.email,
                    contacts: { user_id: r.user_id },
                  }));
                return { data, error: null };
              },
            }),
          }),
        };
      }

      throw new Error(`Unexpected table in calendar sync: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => createServiceClient(),
}));

import { POST } from "@/app/api/calendar/sync/route";

function makeRequest(search = "?force=true") {
  return new NextRequest(`http://localhost/api/calendar/sync${search}`, { method: "POST" });
}

function allUpsertedRows() {
  return eventUpsertBatches.flat();
}

describe("calendar sync batching (CAR-152)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    fromCalls = [];
    gmailUpdates = [];
    eventUpsertBatches = [];
    linkUpsertBatches = [];
    contactEmailQueries = [];
    contactEmailRows = [];
    deletedLinkEventIds = [];
    deletedEventIds = [];
    cancelledLookups = [];
    failEventUpserts = false;
    rowIdByGoogleId.clear();
    nextRowId = 100;
    state.connection = {
      calendar_scopes_granted: true,
      calendar_last_synced_at: "2026-07-09T11:00:00.000Z",
      calendar_sync_token: null,
      gmail_address: "me@example.com",
      access_token: "at",
      refresh_token: "rt",
      token_expires_at: "2026-07-09T13:00:00.000Z",
    };
    fakeApi = createFakeCalendarApi([{ items: [] }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ingests every page and persists only the final page's sync token", async () => {
    fakeApi = createFakeCalendarApi(
      [
        { items: [makeEvent("evt-a"), makeEvent("evt-b")] },
        { items: [makeEvent("evt-c")] },
      ],
      { nextSyncToken: "token-from-page-2" }
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // The real loop followed the pageToken chain.
    expect(fakeApi.listCalls).toHaveLength(2);
    expect(fakeApi.listCalls[0].pageToken).toBeUndefined();
    expect(fakeApi.listCalls[1].pageToken).toBe("page-1");

    // All three events (across pages) reached the bulk upsert.
    const ids = allUpsertedRows().map((r) => r.google_event_id).sort();
    expect(ids).toEqual(["evt-a", "evt-b", "evt-c"]);

    // Only the FINAL page's nextSyncToken persists.
    expect(gmailUpdates.at(-1)).toMatchObject({ calendar_sync_token: "token-from-page-2" });
  });

  it("requests expanded instances: singleEvents always, orderBy only on windowed fetches", async () => {
    fakeApi = createFakeCalendarApi([{ items: [] }]);
    await POST(makeRequest());

    // Windowed fetch (no stored token): singleEvents + orderBy + window.
    expect(fakeApi.listCalls[0]).toMatchObject({
      singleEvents: true,
      orderBy: "startTime",
    });
    expect(fakeApi.listCalls[0].timeMin).toBeTruthy();
    expect(fakeApi.listCalls[0].syncToken).toBeUndefined();

    // Incremental fetch: syncToken + singleEvents, no orderBy/window (Google
    // 400s on either combined with a sync token).
    state.connection = { ...state.connection, calendar_sync_token: "active-token" };
    vi.setSystemTime(new Date("2026-07-09T13:00:00.000Z"));
    fakeApi = createFakeCalendarApi([{ items: [] }]);
    await POST(makeRequest());

    expect(fakeApi.listCalls[0]).toMatchObject({
      singleEvents: true,
      syncToken: "active-token",
    });
    expect(fakeApi.listCalls[0].orderBy).toBeUndefined();
    expect(fakeApi.listCalls[0].timeMin).toBeUndefined();
  });

  it("ingests recurring instances at their real occurrence times with unique ids", async () => {
    fakeApi = createFakeCalendarApi([
      {
        items: [
          makeRecurringInstance("series-1", "2026-07-10T15:00:00.000Z"),
          makeRecurringInstance("series-1", "2026-07-17T15:00:00.000Z"),
        ],
      },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const rows = allUpsertedRows();
    expect(rows).toHaveLength(2);
    const idSet = new Set(rows.map((r) => r.google_event_id));
    expect(idSet.size).toBe(2);
    expect(rows.map((r) => r.start_at).sort()).toEqual([
      "2026-07-10T15:00:00.000Z",
      "2026-07-17T15:00:00.000Z",
    ]);
    expect(rows.every((r) => r.recurring_event_id === "series-1")).toBe(true);
  });

  it("deletes a cancelled instance through the bulk cancellation path", async () => {
    // The instance exists locally from a prior sync.
    idFor("series-1_20260717T150000Z");

    fakeApi = createFakeCalendarApi([
      {
        items: [
          makeEvent("evt-live"),
          makeCancelledInstance("series-1_20260717T150000Z", { recurringEventId: "series-1" }),
        ],
      },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // Cancelled skeleton never reaches the upsert…
    expect(allUpsertedRows().map((r) => r.google_event_id)).toEqual(["evt-live"]);

    // …and is deleted via one .in() per table.
    expect(cancelledLookups).toEqual([["series-1_20260717T150000Z"]]);
    const cancelledRowId = rowIdByGoogleId.get("series-1_20260717T150000Z")!;
    expect(deletedLinkEventIds).toEqual([[cancelledRowId]]);
    expect(deletedEventIds).toEqual([[cancelledRowId]]);
  });

  it("resolves all attendee contacts in one tenant-scoped query and bulk-links them", async () => {
    contactEmailRows = [
      { email: "ana@corp.com", contact_id: 7, user_id: "user-1" },
      { email: "bo@corp.com", contact_id: 9, user_id: "user-1" },
      // Foreign tenant row with a matching email must not attribute (CAR-133).
      { email: "eve@corp.com", contact_id: 999, user_id: "user-2" },
    ];

    fakeApi = createFakeCalendarApi([
      {
        items: [
          makeEvent("evt-1", { attendees: [{ email: "Ana@Corp.com" }, { email: "me@example.com" }] }),
          makeEvent("evt-2", { attendees: [{ email: "bo@corp.com" }, { email: "eve@corp.com" }] }),
        ],
      },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // ONE contact_emails query for the whole batch, lowercased, without the
    // user's own address, scoped by contacts.user_id.
    expect(contactEmailQueries).toHaveLength(1);
    expect(contactEmailQueries[0].emails.sort()).toEqual([
      "ana@corp.com",
      "bo@corp.com",
      "eve@corp.com",
    ]);
    expect(contactEmailQueries[0]).toMatchObject({ scopeCol: "contacts.user_id", scopeVal: "user-1" });

    const rows = allUpsertedRows();
    expect(rows.find((r) => r.google_event_id === "evt-1")?.contact_id).toBe(7);
    expect(rows.find((r) => r.google_event_id === "evt-2")?.contact_id).toBe(9);

    // Links land as one bulk upsert with the RETURNING ids; the foreign
    // tenant's contact 999 never appears.
    expect(linkUpsertBatches).toHaveLength(1);
    expect(linkUpsertBatches[0]).toEqual([
      { calendar_event_id: rowIdByGoogleId.get("evt-1"), contact_id: 7 },
      { calendar_event_id: rowIdByGoogleId.get("evt-2"), contact_id: 9 },
    ]);
  });

  it("collapses duplicate google_event_ids within a batch, last occurrence wins", async () => {
    fakeApi = createFakeCalendarApi([
      { items: [makeEvent("evt-dup", { summary: "old title" })] },
      { items: [makeEvent("evt-dup", { summary: "new title" })] },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const rows = allUpsertedRows().filter((r) => r.google_event_id === "evt-dup");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("new title");
  });

  it("links ALL same-tenant contacts sharing one attendee email", async () => {
    // contact_emails is unique on (contact_id, email), so one email can
    // belong to several of the user's contacts (shared team inbox, duplicate
    // contacts). Every one of them must keep its link.
    contactEmailRows = [
      { email: "team@acme.com", contact_id: 7, user_id: "user-1" },
      { email: "team@acme.com", contact_id: 11, user_id: "user-1" },
    ];

    fakeApi = createFakeCalendarApi([
      { items: [makeEvent("evt-shared", { attendees: [{ email: "team@acme.com" }] })] },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const eventId = rowIdByGoogleId.get("evt-shared")!;
    expect(linkUpsertBatches).toHaveLength(1);
    expect(linkUpsertBatches[0]).toEqual([
      { calendar_event_id: eventId, contact_id: 7 },
      { calendar_event_id: eventId, contact_id: 11 },
    ]);
    // The denormalized scalar stays single-valued (first match).
    expect(allUpsertedRows()[0].contact_id).toBe(7);
  });

  it("ingests all-day events with date-only bounds and all_day set", async () => {
    fakeApi = createFakeCalendarApi([
      { items: [makeAllDayEvent("evt-allday", "2026-07-10", "2026-07-11")] },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const rows = allUpsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      google_event_id: "evt-allday",
      all_day: true,
      start_at: new Date("2026-07-10").toISOString(),
      end_at: new Date("2026-07-11").toISOString(),
    });
  });

  it("recovers from a real 410: clears the token and re-fetches windowed (end-to-end)", async () => {
    // Drives the REAL calendar.ts err.code === 410 -> SYNC_TOKEN_EXPIRED
    // mapping, not a mocked rejection.
    state.connection = { ...state.connection, calendar_sync_token: "expired-tok" };
    fakeApi = createFakeCalendarApi(
      [{ items: [makeEvent("evt-recovered")] }],
      { expiredSyncToken: "expired-tok", nextSyncToken: "fresh-token" }
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // First call carried the expired token and 410'd; the retry is windowed.
    expect(fakeApi.listCalls[0].syncToken).toBe("expired-tok");
    expect(fakeApi.listCalls[1].syncToken).toBeUndefined();
    expect(fakeApi.listCalls[1].timeMin).toBeTruthy();

    // The route nulled the stored token before retrying, ingested the
    // windowed result, and persisted the fresh token.
    expect(gmailUpdates).toContainEqual({ calendar_sync_token: null });
    expect(allUpsertedRows().map((r) => r.google_event_id)).toEqual(["evt-recovered"]);
    expect(gmailUpdates.at(-1)).toMatchObject({ calendar_sync_token: "fresh-token" });
  });

  it("does NOT advance the sync token when an upsert chunk fails", async () => {
    // Advancing the cursor past events that never persisted would drop them
    // permanently — Google only sends deltas after the stored token.
    failEventUpserts = true;
    fakeApi = createFakeCalendarApi(
      [{ items: [makeEvent("evt-lost")] }],
      { nextSyncToken: "must-not-persist" }
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const finalUpdate = gmailUpdates.at(-1)!;
    expect(finalUpdate).not.toHaveProperty("calendar_sync_token");
    expect(finalUpdate.calendar_last_synced_at).toBeTruthy();
    // No links were written for the failed chunk.
    expect(linkUpsertBatches).toHaveLength(0);
  });

  it("issues a constant number of Supabase calls regardless of event count", async () => {
    const attendees = [{ email: "ana@corp.com" }];
    contactEmailRows = [{ email: "ana@corp.com", contact_id: 7, user_id: "user-1" }];

    fakeApi = createFakeCalendarApi([
      { items: [makeEvent("a1", { attendees }), makeEvent("a2", { attendees })] },
    ]);
    await POST(makeRequest());
    const callsForTwo = fromCalls.length;

    vi.setSystemTime(new Date("2026-07-09T13:00:00.000Z"));
    fromCalls = [];
    eventUpsertBatches = [];
    fakeApi = createFakeCalendarApi([
      {
        items: [
          makeEvent("b1", { attendees }),
          makeEvent("b2", { attendees }),
          makeEvent("b3", { attendees }),
          makeEvent("b4", { attendees }),
          makeEvent("b5", { attendees }),
          makeEvent("b6", { attendees }),
        ],
      },
    ]);
    await POST(makeRequest());
    const callsForSix = fromCalls.length;

    expect(allUpsertedRows()).toHaveLength(6);
    expect(callsForSix).toBe(callsForTwo);
  });
});
