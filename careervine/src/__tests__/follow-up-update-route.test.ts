import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * CAR-125: PUT /api/gmail/follow-ups/[id] must rebuild unresolved steps (including
 * expired) and preserve awaiting_review when send_after_days is unchanged.
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };

const inserts: unknown[] = [];
const deletes: { statusIn?: unknown }[] = [];
let followUpRow: Record<string, unknown> | null = {
  id: 10,
  user_id: "u-1",
  status: "active",
  original_sent_at: "2026-07-01T12:00:00Z",
};
let priorOpen: Record<string, unknown>[] = [];
let sentCount = 0;

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: (table: string) => {
      const state: {
        op: "select" | "delete" | "insert" | "update" | null;
        isCount: boolean;
        filters: Record<string, unknown>;
      } = { op: null, isCount: false, filters: {} };

      const b: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          state.op = "select";
          if (opts?.head) state.isCount = true;
          return b;
        },
        delete: () => {
          state.op = "delete";
          return b;
        },
        insert: (rows: unknown) => {
          state.op = "insert";
          inserts.push(rows);
          return b;
        },
        update: () => {
          state.op = "update";
          return b;
        },
        eq: (col: string, val: unknown) => {
          state.filters[col] = val;
          return b;
        },
        in: (col: string, vals: unknown) => {
          state.filters[`${col}_in`] = vals;
          return b;
        },
        single: async () => {
          if (table === "email_follow_ups") {
            return { data: followUpRow, error: null };
          }
          return { data: { id: 10, email_follow_up_messages: [] }, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (state.op === "delete") {
            deletes.push({ statusIn: state.filters.status_in });
            return resolve({ error: null });
          }
          if (state.op === "insert") return resolve({ error: null });
          if (state.op === "update") return resolve({ error: null });
          if (state.isCount) return resolve({ count: sentCount, error: null });
          // prior open snapshot select
          return resolve({ data: priorOpen, error: null });
        },
      };
      return b;
    },
  })),
}));

import { PUT } from "@/app/api/gmail/follow-ups/[id]/route";

describe("PUT /api/gmail/follow-ups/[id] (CAR-125)", () => {
  beforeEach(() => {
    inserts.length = 0;
    deletes.length = 0;
    authedUser = { id: "u-1" };
    followUpRow = {
      id: 10,
      user_id: "u-1",
      status: "active",
      original_sent_at: "2026-07-01T12:00:00Z",
    };
    sentCount = 0;
    priorOpen = [
      {
        sequence_number: 1,
        send_after_days: 7,
        status: "awaiting_review",
        parked_at: "2026-07-10T09:00:00Z",
        expires_at: "2026-07-24T09:00:00Z",
        reminder_count: 1,
        last_reminder_at: null,
        seen_during_window: false,
      },
    ];
  });

  it("deletes unresolved statuses including expired and preserves awaiting_review", async () => {
    const req = new NextRequest("http://localhost/api/gmail/follow-ups/10", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { sendAfterDays: 7, subject: "Nudge", bodyHtml: "<p>Hi</p>" },
        ],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "10" }) });
    expect(res.status).toBe(200);

    expect(deletes.some((d) => Array.isArray(d.statusIn) && d.statusIn.includes("expired"))).toBe(
      true,
    );

    const inserted = inserts[0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("awaiting_review");
    expect(inserted[0].parked_at).toBe("2026-07-10T09:00:00Z");
    expect(inserted[0].subject).toBe("Nudge");
  });

  it("reschedules as pending when delay changes", async () => {
    const req = new NextRequest("http://localhost/api/gmail/follow-ups/10", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { sendAfterDays: 14, subject: "Later nudge", bodyHtml: "<p>Hi</p>" },
        ],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "10" }) });
    expect(res.status).toBe(200);

    const inserted = inserts[0] as Array<Record<string, unknown>>;
    expect(inserted[0].status).toBe("pending");
    expect(inserted[0].parked_at).toBeUndefined();
  });
});
