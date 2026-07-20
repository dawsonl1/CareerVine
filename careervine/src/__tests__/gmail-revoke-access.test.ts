import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * revokeAccess (CAR-156 / R4.6): a full Google disconnect must clear every
 * Google-derived cache — email_messages AND calendar_events — plus the
 * connection row itself. The OAuth grant covers Gmail and Calendar together,
 * so leaving cached event titles/attendees behind would outlive the consent
 * that justified caching them.
 */

interface TableCall {
  table: string;
  ops: Array<{ m: string; args: unknown[] }>;
}

const calls: TableCall[] = [];

/** Response the gmail_connections lookup resolves to; per-test overridable. */
let connectionRead: { data: unknown; error: unknown } = {
  // No access token stored — the Google-side revoke is skipped and the
  // local cleanup (the behavior under test) runs unconditionally.
  data: { access_token: null },
  error: null,
};

function makeBuilder(table: string) {
  const call: TableCall = { table, ops: [] };
  calls.push(call);
  const builder: Record<string, unknown> = {};
  const chain = (m: string) => (...args: unknown[]) => {
    call.ops.push({ m, args });
    return builder;
  };
  for (const m of ["select", "delete", "eq"]) builder[m] = chain(m);
  builder.maybeSingle = async () => {
    call.ops.push({ m: "maybeSingle", args: [] });
    return connectionRead;
  };
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve, reject);
  return builder;
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

import { revokeAccess } from "@/lib/gmail";

const deletesTo = (table: string) =>
  calls.filter((c) => c.table === table && c.ops.some((o) => o.m === "delete"));

beforeEach(() => {
  calls.length = 0;
  connectionRead = { data: { access_token: null }, error: null };
});

describe("revokeAccess", () => {
  it("deletes email_messages, calendar_events, and the connection row, all user-scoped", async () => {
    await revokeAccess("u-1");

    for (const table of ["email_messages", "calendar_events", "gmail_connections"]) {
      const dels = deletesTo(table);
      expect(dels, `expected a delete on ${table}`).toHaveLength(1);
      const eq = dels[0].ops.find((o) => o.m === "eq");
      expect(eq?.args).toEqual(["user_id", "u-1"]);
    }
  });

  it("still cleans up when the user has no connection row at all", async () => {
    // maybeSingle (not single) means "no row" is data:null with no error —
    // the disconnect must proceed rather than reading as a failure.
    connectionRead = { data: null, error: null };

    await revokeAccess("u-1");

    for (const table of ["email_messages", "calendar_events", "gmail_connections"]) {
      expect(deletesTo(table), `expected a delete on ${table}`).toHaveLength(1);
    }
  });

  it("throws instead of silently skipping the Google-side revoke when the read fails", async () => {
    // CAR-158 must() convention: a failed connection read used to fall through
    // as "no access token", deleting local data while leaving the OAuth grant
    // live at Google. It must surface instead.
    connectionRead = { data: null, error: { message: "connection reset" } };

    await expect(revokeAccess("u-1")).rejects.toMatchObject({ message: "connection reset" });
    expect(deletesTo("gmail_connections")).toHaveLength(0);
  });
});
