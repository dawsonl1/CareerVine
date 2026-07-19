import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockFetchCalendarEvents = vi.fn();
const mockGetCalendarTimezone = vi.fn();
const mockGetCalendarList = vi.fn();
// CAR-152: the route bulk-upserts row arrays and chains .select() for the
// RETURNING ids, so the mock returns a builder instead of a bare result.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock mirrors the route's any-typed rows (CAR-142)
const calendarEventUpsert = vi.fn((rows: any[], _opts: Record<string, unknown>) => ({
  select: async () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock mirrors the route's any-typed rows (CAR-142)
    data: rows.map((r: any, i: number) => ({ id: 42 + i, google_event_id: r.google_event_id })),
    error: null,
  }),
}));

const state = {
  connection: {
    calendar_scopes_granted: true,
    calendar_last_synced_at: null as string | null,
    calendar_sync_token: null as string | null,
    gmail_address: "me@example.com",
  },
};

const gmailUpdates: Array<Record<string, unknown>> = [];
const calendarEventContactUpserts: Array<Record<string, unknown>> = [];

// contact_emails store — each row carries its owning tenant via the contacts
// join, so the mock can enforce the same tenant scoping the real join does.
let contactEmailRows: Array<{ email: string; contact_id: number; user_id: string }> = [];
// Records the (column, value) passed to the tenant-scoping .eq() so a test can
// prove the route actually filters by contacts.user_id.
const contactEmailFilters: Array<{ col: string; val: unknown }> = [];

vi.mock("@/lib/calendar", () => ({
  fetchCalendarEvents: (...args: unknown[]) => mockFetchCalendarEvents(...args),
  getCalendarTimezone: (...args: unknown[]) => mockGetCalendarTimezone(...args),
  getCalendarList: (...args: unknown[]) => mockGetCalendarList(...args),
  DEFAULT_TIMEZONE: "America/New_York",
}));

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }),
}));

function createServiceClient() {
  return {
    from: (table: string) => {
      if (table === "gmail_connections") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: state.connection, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            gmailUpdates.push(payload);
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      }

      if (table === "calendar_events") {
        return {
          upsert: calendarEventUpsert,
          // Cancellation lookup: select("id").eq(user).in(google_event_ids).
          select: () => ({
            eq: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          }),
          delete: () => ({
            in: async () => ({ error: null }),
          }),
        };
      }

      if (table === "calendar_event_contacts") {
        return {
          upsert: async (
            rows: Array<Record<string, unknown>>,
            _opts: Record<string, unknown>
          ) => {
            calendarEventContactUpserts.push(...rows);
            return { error: null };
          },
          delete: () => ({
            in: async () => ({ error: null }),
          }),
        };
      }

      if (table === "contact_emails") {
        // Model the contacts!inner(user_id) join: .in(email) then
        // .eq("contacts.user_id", user.id) must exclude foreign-tenant rows.
        return {
          select: () => ({
            in: (_col: string, emails: string[]) => ({
              eq: async (col: string, val: unknown) => {
                contactEmailFilters.push({ col, val });
                const data = contactEmailRows
                  .filter((r) => emails.includes(r.email))
                  .filter((r) => r.user_id === val)
                  .map((r) => ({
                    contact_id: r.contact_id,
                    email: r.email,
                    contacts: { user_id: r.user_id },
                  }));
                return { data };
              },
            }),
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  };
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => createServiceClient(),
}));

import { POST } from "@/app/api/calendar/sync/route";

function makeRequest(search = "") {
  return new NextRequest(`http://localhost/api/calendar/sync${search}`, { method: "POST" });
}

describe("/api/calendar/sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    vi.clearAllMocks();
    gmailUpdates.length = 0;
    calendarEventContactUpserts.length = 0;
    contactEmailFilters.length = 0;
    contactEmailRows = [];
    state.connection = {
      calendar_scopes_granted: true,
      calendar_last_synced_at: null,
      calendar_sync_token: null,
      gmail_address: "me@example.com",
    };
    mockGetCalendarTimezone.mockResolvedValue("America/New_York");
    mockGetCalendarList.mockResolvedValue([]);
    mockFetchCalendarEvents.mockResolvedValue({ events: [], nextSyncToken: "next-token" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 7-day lookback and 60-day lookahead on first sync", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const firstCall = mockFetchCalendarEvents.mock.calls[0]?.[1];
    expect(firstCall).toMatchObject({
      syncToken: null,
      timeMin: "2026-07-02T12:00:00.000Z",
      timeMax: "2026-09-07T12:00:00.000Z",
    });
  });

  it("retries with the same backfill window when sync token is expired", async () => {
    state.connection = {
      ...state.connection,
      calendar_last_synced_at: "2026-07-09T11:00:00.000Z",
      calendar_sync_token: "stale-token",
    };

    mockFetchCalendarEvents
      .mockRejectedValueOnce(new Error("SYNC_TOKEN_EXPIRED"))
      .mockResolvedValueOnce({ events: [], nextSyncToken: "fresh-token" });

    const res = await POST(makeRequest("?force=true"));
    expect(res.status).toBe(200);
    expect(mockFetchCalendarEvents).toHaveBeenCalledTimes(2);

    expect(mockFetchCalendarEvents.mock.calls[0]?.[1]).toMatchObject({
      syncToken: "stale-token",
      timeMin: "2026-07-02T12:00:00.000Z",
      timeMax: "2026-09-07T12:00:00.000Z",
    });
    expect(mockFetchCalendarEvents.mock.calls[1]?.[1]).toMatchObject({
      timeMin: "2026-07-02T12:00:00.000Z",
      timeMax: "2026-09-07T12:00:00.000Z",
    });
    expect(mockFetchCalendarEvents.mock.calls[1]?.[1]).not.toHaveProperty("syncToken");
  });

  it("keeps incremental sync token behavior for non-first sync", async () => {
    state.connection = {
      ...state.connection,
      calendar_last_synced_at: "2026-07-09T11:00:00.000Z",
      calendar_sync_token: "active-token",
    };

    const res = await POST(makeRequest("?force=true"));
    expect(res.status).toBe(200);
    expect(mockFetchCalendarEvents).toHaveBeenCalledTimes(1);
    expect(mockFetchCalendarEvents.mock.calls[0]?.[1]).toMatchObject({
      syncToken: "active-token",
    });
  });

  it("upserts events on the (user_id, google_event_id) natural key, not the PK (CAR-113)", async () => {
    // Without onConflict the upsert conflict-targets the bigserial PK, so every
    // re-synced event INSERTs and trips calendar_events_user_id_google_event_id_key
    // (23505) — and the event's edits never reach the cache.
    mockFetchCalendarEvents.mockResolvedValue({
      events: [
        {
          id: "evt-1",
          status: "confirmed",
          start: { dateTime: "2026-07-10T15:00:00.000Z" },
          end: { dateTime: "2026-07-10T16:00:00.000Z" },
          summary: "Coffee chat",
        },
      ],
      nextSyncToken: "next-token",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(calendarEventUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ user_id: "user-1", google_event_id: "evt-1" }),
      ]),
      { onConflict: "user_id,google_event_id" },
    );
  });

  it("does NOT match an attendee email that belongs to another tenant's contact (CAR-133 / R2.1)", async () => {
    // contact_emails has no user_id column, so an unscoped service-client match
    // is global across tenants. A foreign contact whose email happens to be an
    // attendee on this user's event must never be linked.
    contactEmailRows = [
      { email: "attendee@corp.com", contact_id: 999, user_id: "user-2" },
    ];

    mockFetchCalendarEvents.mockResolvedValue({
      events: [
        {
          id: "evt-foreign",
          status: "confirmed",
          start: { dateTime: "2026-07-10T15:00:00.000Z" },
          end: { dateTime: "2026-07-10T16:00:00.000Z" },
          summary: "Coffee chat",
          attendees: [{ email: "attendee@corp.com" }],
        },
      ],
      nextSyncToken: "next-token",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // The route must scope the match by contacts.user_id = the caller.
    expect(contactEmailFilters).toContainEqual({ col: "contacts.user_id", val: "user-1" });

    // No foreign contact_id reaches the event row...
    expect(calendarEventUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ google_event_id: "evt-foreign", contact_id: null }),
      ]),
      { onConflict: "user_id,google_event_id" },
    );
    // ...and no cross-tenant link row is written.
    expect(calendarEventContactUpserts).toHaveLength(0);
  });

  it("matches an attendee email that belongs to the caller's own contact", async () => {
    contactEmailRows = [
      { email: "attendee@corp.com", contact_id: 7, user_id: "user-1" },
    ];

    mockFetchCalendarEvents.mockResolvedValue({
      events: [
        {
          id: "evt-own",
          status: "confirmed",
          start: { dateTime: "2026-07-10T15:00:00.000Z" },
          end: { dateTime: "2026-07-10T16:00:00.000Z" },
          summary: "Coffee chat",
          attendees: [{ email: "attendee@corp.com" }],
        },
      ],
      nextSyncToken: "next-token",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(calendarEventUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ google_event_id: "evt-own", contact_id: 7 }),
      ]),
      { onConflict: "user_id,google_event_id" },
    );
    // The link uses the id returned by the bulk upsert's RETURNING rows
    // (the mock assigns 42 to the first row).
    expect(calendarEventContactUpserts).toContainEqual({
      calendar_event_id: 42,
      contact_id: 7,
    });
  });
});
