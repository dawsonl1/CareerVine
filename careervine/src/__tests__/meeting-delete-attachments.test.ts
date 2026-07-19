import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * deleteMeeting attachment reclamation (CAR-156 / R4.7): deleting a meeting
 * must also delete attachments that belong exclusively to it — including the
 * transcript recording (raw meeting audio, the largest PII object we hold) —
 * row AND storage object, via the deleteAttachment path. Cascades only clear
 * junction rows, and the storage sweep can't reclaim an object whose
 * attachments row survives, so this path is the only thing that frees them.
 * Attachments still referenced by a contact, an interaction, or another
 * meeting must survive.
 */

interface Call {
  table: string;
  ops: Array<{ m: string; args: unknown[] }>;
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    storageRemoved: [] as string[][],
    respond: (_c: Call): { data: unknown; error: unknown } => ({ data: null, error: null }),
  };

  function makeBuilder(table: string) {
    const call: Call = { table, ops: [] };
    state.calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = (m: string) => (...args: unknown[]) => {
      call.ops.push({ m, args });
      return builder;
    };
    for (const m of ["select", "delete", "eq", "in", "neq", "order", "limit"]) {
      builder[m] = chain(m);
    }
    builder.maybeSingle = async () => {
      call.ops.push({ m: "maybeSingle", args: [] });
      return state.respond(call);
    };
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(state.respond(call)).then(onF, onR);
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    from: (t: string) => h.makeBuilder(t),
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          h.state.storageRemoved.push(paths);
          return { error: null };
        },
      }),
    },
  }),
}));

import { deleteMeeting } from "@/lib/data/meetings";

const ops = (c: Call) => c.ops.map((o) => o.m);
const callsTo = (table: string) => h.state.calls.filter((c) => c.table === table);

/**
 * Responder for a meeting (id 5) whose transcript recording is attachment 42.
 * `sharedIn` names the table (if any) that still references attachment 42.
 */
function respondWith(sharedIn: "contact_attachments" | "interaction_attachments" | "other_meeting" | null) {
  h.state.respond = (c) => {
    const o = ops(c);
    if (c.table === "meetings" && o.includes("maybeSingle")) {
      return { data: { transcript_attachment_id: 42 }, error: null };
    }
    if (c.table === "meeting_attachments" && !o.includes("neq")) {
      return { data: [{ attachment_id: 42 }], error: null };
    }
    if (c.table === "contact_attachments") {
      return { data: sharedIn === "contact_attachments" ? [{ attachment_id: 42 }] : [], error: null };
    }
    if (c.table === "interaction_attachments") {
      return { data: sharedIn === "interaction_attachments" ? [{ attachment_id: 42 }] : [], error: null };
    }
    if (c.table === "meeting_attachments" && o.includes("neq")) {
      return { data: sharedIn === "other_meeting" ? [{ attachment_id: 42 }] : [], error: null };
    }
    if (c.table === "meetings" && o.includes("in")) {
      return { data: [], error: null };
    }
    if (c.table === "attachments" && o.includes("select")) {
      return { data: [{ id: 42, object_path: "u1/rec.mp3" }], error: null };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  h.state.calls = [];
  h.state.storageRemoved = [];
  h.state.respond = () => ({ data: null, error: null });
});

describe("deleteMeeting", () => {
  it("deletes an exclusively-owned recording: storage object + attachment row + meeting", async () => {
    respondWith(null);

    await deleteMeeting(5);

    expect(h.state.storageRemoved).toEqual([["u1/rec.mp3"]]);
    const attachmentDeletes = callsTo("attachments").filter((c) => ops(c).includes("delete"));
    expect(attachmentDeletes).toHaveLength(1);
    expect(callsTo("meetings").some((c) => ops(c).includes("delete"))).toBe(true);
    expect(callsTo("meeting_contacts").some((c) => ops(c).includes("delete"))).toBe(true);
  });

  it("keeps an attachment still linked to a contact", async () => {
    respondWith("contact_attachments");

    await deleteMeeting(5);

    expect(h.state.storageRemoved).toEqual([]);
    expect(callsTo("attachments")).toHaveLength(0);
    expect(callsTo("meetings").some((c) => ops(c).includes("delete"))).toBe(true);
  });

  it("keeps an attachment still linked to another meeting", async () => {
    respondWith("other_meeting");

    await deleteMeeting(5);

    expect(h.state.storageRemoved).toEqual([]);
    expect(callsTo("attachments")).toHaveLength(0);
    expect(callsTo("meetings").some((c) => ops(c).includes("delete"))).toBe(true);
  });

  it("skips all attachment work for a meeting with no attachments", async () => {
    h.state.respond = (c) => {
      if (c.table === "meetings" && ops(c).includes("maybeSingle")) {
        return { data: { transcript_attachment_id: null }, error: null };
      }
      return { data: [], error: null };
    };

    await deleteMeeting(5);

    expect(h.state.storageRemoved).toEqual([]);
    expect(callsTo("attachments")).toHaveLength(0);
    expect(callsTo("contact_attachments")).toHaveLength(0);
    expect(callsTo("meetings").some((c) => ops(c).includes("delete"))).toBe(true);
  });
});
