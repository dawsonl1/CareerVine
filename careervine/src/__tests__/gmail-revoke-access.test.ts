import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * revokeAccess (CAR-156 / R4.6): a full Google disconnect must clear every
 * Google-derived cache — email_messages AND calendar_events — plus the
 * connection row itself. The OAuth grant covers Gmail and Calendar together,
 * so leaving cached event titles/attendees behind would outlive the consent
 * that justified caching them.
 *
 * CAR-172: it must ALSO reset the per-contact ingestion state
 * (email_synced_through / email_backfilled_at) BEFORE the wipe. The watermark
 * lives on contacts and survives the cache delete; a reconnect resuming from
 * it would never re-fetch the deleted span — silent, unrecoverable history
 * loss. Ordering is the safety property: a failed reset aborts the wipe.
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

/** Error injected into the contacts watermark-reset update; per-test overridable. */
let contactsUpdateError: unknown = null;

function makeBuilder(table: string) {
  const call: TableCall = { table, ops: [] };
  calls.push(call);
  const builder: Record<string, unknown> = {};
  const chain = (m: string) => (...args: unknown[]) => {
    call.ops.push({ m, args });
    return builder;
  };
  for (const m of ["select", "delete", "update", "eq", "or"]) builder[m] = chain(m);
  builder.maybeSingle = async () => {
    call.ops.push({ m: "maybeSingle", args: [] });
    return connectionRead;
  };
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const isContactsUpdate = table === "contacts" && call.ops.some((o) => o.m === "update");
    return Promise.resolve({ data: null, error: isContactsUpdate ? contactsUpdateError : null }).then(
      resolve,
      reject,
    );
  };
  return builder;
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

import { revokeAccess } from "@/lib/gmail";

const deletesTo = (table: string) =>
  calls.filter((c) => c.table === table && c.ops.some((o) => o.m === "delete"));
const updatesTo = (table: string) =>
  calls.filter((c) => c.table === table && c.ops.some((o) => o.m === "update"));

beforeEach(() => {
  calls.length = 0;
  connectionRead = { data: { access_token: null }, error: null };
  contactsUpdateError = null;
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

  it("nulls the per-contact ingestion watermarks, user-scoped, BEFORE deleting the cache (CAR-172)", async () => {
    await revokeAccess("u-1");

    const resets = updatesTo("contacts");
    expect(resets).toHaveLength(1);
    const update = resets[0].ops.find((o) => o.m === "update");
    expect(update?.args[0]).toEqual({ email_synced_through: null, email_backfilled_at: null });
    const eq = resets[0].ops.find((o) => o.m === "eq");
    expect(eq?.args).toEqual(["user_id", "u-1"]);

    // Order: the reset call must be issued before the email_messages delete.
    // The reverse order could strand deleted mail behind a live watermark —
    // exactly the CAR-172 history-loss bug.
    const resetIdx = calls.indexOf(resets[0]);
    const deleteIdx = calls.indexOf(deletesTo("email_messages")[0]);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeLessThan(deleteIdx);
  });

  it("aborts the wipe when the watermark reset fails (nothing deleted, error surfaces)", async () => {
    contactsUpdateError = { message: "reset failed" };

    await expect(revokeAccess("u-1")).rejects.toMatchObject({ message: "reset failed" });
    for (const table of ["email_messages", "calendar_events", "gmail_connections"]) {
      expect(deletesTo(table), `expected NO delete on ${table}`).toHaveLength(0);
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
