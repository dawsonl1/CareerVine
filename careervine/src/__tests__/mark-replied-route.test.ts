import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: POST /api/gmail/follow-ups/mark-replied — the free-tier manual reply
 * signal. Guards ownership, then delegates to recordThreadReply which cancels
 * active sequences, activates the contact, records a simulated inbound row, and
 * fires reply_received exactly once (idempotent on that row).
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
const state: {
  outbound: { ai_assisted?: boolean; matched_contact_id?: number | null } | null;
  inbound: unknown;
  seqs: { id: number }[];
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
  insertError: unknown;
} = { outbound: null, inbound: null, seqs: [], inserts: [], updates: [], insertError: null };

const activateSpy = vi.fn(async () => {});
const trackSpy = vi.fn(async () => {});

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/gmail", () => ({
  activateContactByEmail: (...a: unknown[]) => activateSpy(...a),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: (...a: unknown[]) => trackSpy(...a),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: (table: string) => {
      let selectStr = "";
      let direction = "";
      let mode: "read" | "update" = "read";
      const b: Record<string, unknown> = {
        select: (s: string) => {
          selectStr = s;
          return b;
        },
        update: (patch: Record<string, unknown>) => {
          mode = "update";
          state.updates.push({ table, patch });
          return b;
        },
        insert: (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return Promise.resolve({ error: state.insertError ?? null });
        },
        eq: (col: string, val: string) => {
          if (col === "direction") direction = val;
          return b;
        },
        in: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => {
          if (table === "email_messages") {
            if (direction === "outbound") {
              return selectStr.includes("ai_assisted")
                ? { data: state.outbound }
                : { data: state.outbound ? { id: 1 } : null };
            }
            if (direction === "inbound") return { data: state.inbound };
          }
          return { data: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (mode === "update") return resolve({ error: null });
          if (table === "email_follow_ups") return resolve({ data: state.seqs });
          return resolve({ data: null, error: null });
        },
      };
      return b;
    },
  })),
}));

import { POST } from "@/app/api/gmail/follow-ups/mark-replied/route";

function makeRequest(body: unknown) {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/gmail/follow-ups/mark-replied"),
    url: "http://localhost:3000/api/gmail/follow-ups/mark-replied",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as never;
}

async function call(body: unknown) {
  const res = await POST(makeRequest(body), { params: Promise.resolve({}) });
  return { status: res.status, data: await res.json() };
}

describe("POST /api/gmail/follow-ups/mark-replied (CAR-102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1" };
    state.outbound = { ai_assisted: false, matched_contact_id: 7 };
    state.inbound = null;
    state.seqs = [{ id: 11 }];
    state.inserts = [];
    state.updates = [];
    state.insertError = null;
  });

  it("404s when the user never sent on this thread", async () => {
    state.outbound = null;
    const { status } = await call({ threadId: "t-1", recipientEmail: "jane@corp.com" });
    expect(status).toBe(404);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("cancels the sequence, activates the contact, records a simulated reply, and fires reply_received once", async () => {
    const { status, data } = await call({ threadId: "t-1", recipientEmail: "jane@corp.com" });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.alreadyMarked).toBe(false);
    expect(state.updates.some((u) => u.table === "email_follow_ups" && u.patch.status === "cancelled_reply")).toBe(true);
    expect(state.updates.some((u) => u.table === "email_follow_up_messages" && u.patch.status === "cancelled")).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith("u-1", "jane@corp.com");
    const inboundInsert = state.inserts.find((i) => i.table === "email_messages");
    expect(inboundInsert?.row.direction).toBe("inbound");
    expect(inboundInsert?.row.is_simulated).toBe(true);
    expect(inboundInsert?.row.gmail_message_id).toBe("manual-reply-t-1");
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith("u-1", "reply_received", { ai_assisted: false });
  });

  it("is idempotent: a thread that already has an inbound message does not double-record or double-fire", async () => {
    state.inbound = { id: 99 };
    const { status, data } = await call({ threadId: "t-1", recipientEmail: "jane@corp.com" });
    expect(status).toBe(200);
    expect(data.alreadyMarked).toBe(true);
    expect(state.inserts.length).toBe(0);
    expect(trackSpy).not.toHaveBeenCalled();
    expect(activateSpy).toHaveBeenCalled();
  });

  it("loses a concurrent insert race (unique violation) -> alreadyMarked, does NOT double-fire reply_received", async () => {
    // No inbound row yet, so the pre-insert idempotency check passes — but a
    // concurrent mark/confirm wins the insert first, so ours hits the unique
    // constraint. The error must be treated as already-recorded (review N4).
    state.inbound = null;
    state.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    const { status, data } = await call({ threadId: "t-1", recipientEmail: "jane@corp.com" });
    expect(status).toBe(200);
    expect(data.alreadyMarked).toBe(true);
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
