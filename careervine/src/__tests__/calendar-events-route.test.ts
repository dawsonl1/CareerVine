/**
 * `GET /api/calendar/events` — the attendee narrowing at the read boundary
 * (CAR-191 review).
 *
 * WHY THIS FILE EXISTS. The route normalizes `calendar_events.attendees` before
 * handing rows to the client, and that behaviour had NO test at all: the E2E
 * flow that first exposed the crash was changed to seed a well-formed `[]`, so
 * deleting the normalization left the entire suite — unit, integration and E2E —
 * green. `vitest.config.ts` scopes `coverage.include` to `src/lib/**` and
 * `src/hooks/**`, so `src/app/api/**` is unmeasured and the coverage gate could
 * not have flagged the gap either.
 *
 * WHAT IT PINS. `attendees` is `jsonb`: the column accepts any JSON, and no
 * CHECK or NOT NULL constrains it. Every consumer treats it as an array —
 * `app/calendar/page.tsx` types it `CalendarAttendee[]` and calls `.length`,
 * `.some`, `.map` and `.slice` on it, in the top-level render outside the page's
 * only SectionBoundary. So a bad value does not degrade one row, it blanks the
 * whole route through the error boundary.
 *
 * The non-array cases are the point. A `?? []` guard passes them straight
 * through and only looks correct; `parseCalendarAttendees` is the repo's
 * designated narrowing seam and rejects them. Each case below fails against
 * `?? []` and passes against the helper.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockServerClientModule, mockServiceClientModule } from "./helpers/mock-supabase";

/** Rows the mocked service client returns for the current test. */
let rows: Array<Record<string, unknown>>;

vi.mock("@/lib/supabase/server-client", () =>
  mockServerClientModule({ user: () => ({ id: "user-1" }) }),
);

// Through the shared factory, not a hand-rolled object literal: an untyped
// module mock keeps compiling after the real export changes, which is the drift
// `scripts/check-conventions.mjs` rejects (CAR-187).
vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from: () => {
      // The route chains .select().eq().order() and may add .gte()/.lte()
      // depending on the query string, then awaits the builder. A thenable that
      // returns itself from every chain step models that without caring which
      // filters were applied.
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "gte", "lte"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      return builder;
    },
  })),
);

const { GET } = await import("@/app/api/calendar/events/route");

function eventRow(attendees: unknown): Record<string, unknown> {
  return {
    id: 1,
    user_id: "user-1",
    google_event_id: "evt-1",
    title: "Coffee",
    start_at: "2026-01-01T17:00:00Z",
    end_at: "2026-01-01T17:30:00Z",
    attendees,
  };
}

async function fetchEvents(): Promise<Array<{ attendees: unknown }>> {
  const res = await GET(new NextRequest("http://localhost/api/calendar/events"));
  const body = (await res.json()) as { events: Array<{ attendees: unknown }> };
  expect(res.status).toBe(200);
  return body.events;
}

beforeEach(() => {
  rows = [];
});

describe("GET /api/calendar/events attendee narrowing", () => {
  it("turns a SQL NULL into an empty array", async () => {
    rows = [eventRow(null)];
    const [event] = await fetchEvents();
    expect(event.attendees).toEqual([]);
  });

  // The cases `?? []` cannot handle. jsonb accepts each of these, and each one
  // reaches `.some()` / `.length` / `.map()` on the calendar page.
  it.each([
    ["a JSON string", "x"],
    ["a JSON number", 7],
    ["a JSON object", { email: "solo@example.com" }],
    ["a JSON boolean", true],
  ])("turns %s into an empty array rather than passing it through", async (_label, value) => {
    rows = [eventRow(value)];
    const [event] = await fetchEvents();
    expect(event.attendees).toEqual([]);
  });

  it("keeps well-formed attendees, normalized to the shared shape", async () => {
    rows = [
      eventRow([
        { email: "a@example.com", name: "A", responseStatus: "accepted" },
        { email: "b@example.com" },
      ]),
    ];
    const [event] = await fetchEvents();
    expect(event.attendees).toEqual([
      { email: "a@example.com", name: "A", responseStatus: "accepted" },
      { email: "b@example.com", name: undefined, responseStatus: undefined },
    ]);
  });

  it("drops entries with no usable email instead of throwing", async () => {
    rows = [eventRow([{ name: "No address" }, null, "nope", { email: "ok@example.com" }])];
    const [event] = await fetchEvents();
    expect(event.attendees).toEqual([
      { email: "ok@example.com", name: undefined, responseStatus: undefined },
    ]);
  });

  it("normalizes every row, not just the first", async () => {
    rows = [eventRow(null), eventRow("x"), eventRow([{ email: "c@example.com" }])];
    const events = await fetchEvents();
    expect(events.map((e) => e.attendees)).toEqual([
      [],
      [],
      [{ email: "c@example.com", name: undefined, responseStatus: undefined }],
    ]);
  });
});
