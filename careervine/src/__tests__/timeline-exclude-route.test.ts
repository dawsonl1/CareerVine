/**
 * `POST|DELETE /api/timeline/exclude` — striking a timeline entry from every
 * derived calculation, and putting it back (CAR-260).
 *
 * Three things here are silent when wrong, and none of them shows up in the UI:
 *
 *  1. **An email must set BOTH flags.** Exclusion is a strict superset of
 *     hiding, and that is the entire reason the contact Emails tab and the
 *     inbox needed no change: they already filter `is_hidden`. Setting only
 *     `is_excluded` leaves the struck message rendering in both, still visibly
 *     part of the history while quietly counting toward nothing.
 *  2. **A meeting must cascade to its calendar event.** `getContactStages`
 *     reads `calendar_events` DIRECTLY as well as through the mirroring
 *     meeting, and collapses the two on `google_event_id`. Excluding only the
 *     meeting row leaves `hasPastCall` true, so the contact keeps deriving as
 *     `call_done` and the company keeps its traction chip.
 *  3. **A miss must 404.** RLS makes another tenant's id update zero rows, and
 *     a handler that ignored the readback would answer `{ success: true }` to
 *     a request that changed nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockServerClientModule } from "./helpers/mock-supabase";

/** Every update the route issued: table, payload, and the filters applied. */
type Recorded = { table: string; values: Record<string, unknown>; filters: Record<string, unknown> };
let recorded: Recorded[] = [];
/** Rows each successive `.select()` readback resolves to, in call order. */
let readbacks: Array<Array<Record<string, unknown>>>;

vi.mock("@/lib/supabase/server-client", () =>
  mockServerClientModule({
    user: () => ({ id: "user-1" }),
    client: () => ({
    from: (table: string) => {
      const entry: Recorded = { table, values: {}, filters: {} };
      const builder: Record<string, unknown> = {};
      builder.update = (values: Record<string, unknown>) => {
        entry.values = values;
        // `withApiHandler` stamps users.web_last_seen_at on every authenticated
        // request. That is the wrapper's write, not the route's, and recording
        // it would make every assertion below index off by one.
        if (table !== "users") recorded.push(entry);
        return builder;
      };
      builder.eq = (col: string, val: unknown) => {
        entry.filters[col] = val;
        return builder;
      };
      // A chain ending in .select() resolves to the readback rows; one without
      // it is awaited directly, which is the calendar cascade's shape.
      builder.select = () => {
        const data = readbacks.shift() ?? [];
        return Promise.resolve({ data, error: null });
      };
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return builder;
    },
    }),
  }),
);

const { POST, DELETE } = await import("@/app/api/timeline/exclude/route");

function req(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/timeline/exclude", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  recorded = [];
  readbacks = [];
});

describe("POST /api/timeline/exclude", () => {
  it("sets is_hidden alongside is_excluded on an email", async () => {
    readbacks = [[{ id: 1 }]];
    const res = await POST(req({ kind: "email", gmailMessageId: "m-auto" }));
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("email_messages");
    expect(recorded[0].values).toEqual({ is_excluded: true, is_hidden: true });
    expect(recorded[0].filters).toEqual({ gmail_message_id: "m-auto" });
  });

  it("cascades a meeting to the calendar event the stage engine reads directly", async () => {
    readbacks = [[{ id: 5, calendar_event_id: "g-evt-1" }]];
    const res = await POST(req({ kind: "meeting", id: 5 }));
    expect(res.status).toBe(200);
    expect(recorded.map((r) => r.table)).toEqual(["meetings", "calendar_events"]);
    expect(recorded[1].values).toEqual({ is_excluded: true });
    expect(recorded[1].filters).toEqual({ google_event_id: "g-evt-1" });
  });

  it("skips the cascade for a meeting with no linked calendar event", async () => {
    readbacks = [[{ id: 6, calendar_event_id: null }]];
    await POST(req({ kind: "meeting", id: 6 }));
    expect(recorded.map((r) => r.table)).toEqual(["meetings"]);
  });

  it("writes an interaction by primary key, never a dynamic table name", async () => {
    readbacks = [[{ id: 9 }]];
    await POST(req({ kind: "interaction", id: 9 }));
    expect(recorded[0].table).toBe("interactions");
    expect(recorded[0].filters).toEqual({ id: 9 });
  });

  it("404s when the update matched nothing, which is how RLS reports a foreign id", async () => {
    readbacks = [[]];
    const res = await POST(req({ kind: "interaction", id: 12345 }));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown kind at the schema rather than in the handler", async () => {
    const res = await POST(req({ kind: "contact", id: 1 }));
    expect(res.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });
});

describe("DELETE /api/timeline/exclude", () => {
  it("clears both flags on an email, so restoring is a true inverse", async () => {
    readbacks = [[{ id: 1 }]];
    const res = await DELETE(req({ kind: "email", gmailMessageId: "m-auto" }, "DELETE"));
    expect(res.status).toBe(200);
    expect(recorded[0].values).toEqual({ is_excluded: false, is_hidden: false });
  });

  it("un-cascades the calendar event too", async () => {
    readbacks = [[{ id: 5, calendar_event_id: "g-evt-1" }]];
    await DELETE(req({ kind: "meeting", id: 5 }, "DELETE"));
    expect(recorded.map((r) => r.values)).toEqual([{ is_excluded: false }, { is_excluded: false }]);
  });
});
