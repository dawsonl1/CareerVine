/**
 * `fetchCalendarEvents` must ask Google for deleted events (CAR-254).
 *
 * Google omits deleted events from `events.list` unless `showDeleted` is true —
 * it does NOT return them as status:"cancelled" skeletons by default. The sync
 * route's cancellation branch keys on exactly that status, so without the flag
 * that branch is unreachable and deleting an event in Google never removed it
 * from CareerVine. Measured against the real account while diagnosing: 18
 * events with showDeleted=false, 19 with it, the extra one being the deleted
 * event, reported by `events.get` as status "cancelled".
 *
 * This has to be tested HERE rather than in the sync-route suite. That suite
 * mocks `fetchCalendarEvents` wholesale and hands it a hand-written cancelled
 * event, so its "deletes a cancelled instance" case passes whether or not
 * Google would ever have sent one. It proves the branch works; only this file
 * proves the branch is reachable. (Same trap calendar-timezone.test.ts documents
 * for CAR-220.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockServiceClientModule } from "./helpers/mock-supabase";

const eventsList = vi.fn();

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              access_token: "enc-access",
              refresh_token: "enc-refresh",
              token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              calendar_scopes_granted: true,
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  })),
);

vi.mock("@/lib/crypto", () => ({
  decryptOAuthToken: (v: string) => v,
  encryptOAuthToken: (v: string) => v,
}));

vi.mock("@/lib/google-oauth", () => ({
  getOAuth2Client: () => ({ setCredentials: () => {}, on: () => {}, credentials: {} }),
}));

vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ events: { list: (...a: unknown[]) => eventsList(...a) } }),
  auth: { OAuth2: class {} },
}));

import { fetchCalendarEvents } from "@/lib/calendar";

type ListParams = { showDeleted?: boolean; syncToken?: string; orderBy?: string; timeMin?: string };

beforeEach(() => {
  eventsList.mockReset();
  eventsList.mockResolvedValue({ data: { items: [], nextSyncToken: null } });
});

const paramsOf = (call: number): ListParams => eventsList.mock.calls[call][0] as ListParams;

describe("fetchCalendarEvents asks Google for deleted events (CAR-254)", () => {
  it("sets showDeleted on the windowed path, which is the only path that runs in production", async () => {
    await fetchCalendarEvents("u1", { timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-09-01T00:00:00Z" });
    const p = paramsOf(0);
    expect(p.showDeleted).toBe(true);
    // Guard the reasoning, not just the flag: `orderBy` is what makes Google
    // withhold a nextSyncToken, which is why every connection has a null
    // calendar_sync_token and the incremental path never engages. If this ever
    // stops being set, re-check whether the windowed path is still the default.
    expect(p.orderBy).toBe("startTime");
    expect(p.timeMin).toBe("2026-08-01T00:00:00Z");
  });

  it("sets showDeleted on the incremental path too", async () => {
    await fetchCalendarEvents("u1", { syncToken: "tok-123" });
    const p = paramsOf(0);
    expect(p.showDeleted).toBe(true);
    expect(p.syncToken).toBe("tok-123");
  });

  it("returns the cancelled skeletons Google sends, so the sync can delete them", async () => {
    // The shape the deletion branch consumes: no start/end, just an id and the
    // cancelled status.
    eventsList.mockResolvedValue({
      data: { items: [{ id: "deleted-evt", status: "cancelled" }], nextSyncToken: null },
    });
    const { events } = await fetchCalendarEvents("u1", { timeMin: "2026-08-01T00:00:00Z" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "deleted-evt", status: "cancelled" });
  });
});
