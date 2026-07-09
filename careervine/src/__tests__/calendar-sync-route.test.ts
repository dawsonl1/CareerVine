import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockFetchCalendarEvents = vi.fn();
const mockGetCalendarTimezone = vi.fn();
const mockGetCalendarList = vi.fn();

const state = {
  connection: {
    calendar_scopes_granted: true,
    calendar_last_synced_at: null as string | null,
    calendar_sync_token: null as string | null,
    gmail_address: "me@example.com",
  },
};

const gmailUpdates: Array<Record<string, unknown>> = [];

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
          upsert: async () => ({ error: null }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: null }),
              }),
            }),
          }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }

      if (table === "calendar_event_contacts") {
        return {
          upsert: async () => ({ error: null }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }

      if (table === "contact_emails") {
        return {
          select: () => ({
            in: async () => ({ data: [] }),
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
});
