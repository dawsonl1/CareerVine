import { describe, it, expect, vi, beforeEach } from "vitest";
import { typedMock } from "./helpers/typed-mock";

/**
 * CAR-234: the scheduled Gmail sweeps.
 *
 * The invariants worth guarding are about WHO and WHAT gets swept, because both
 * failure directions are expensive and neither is visible from the outside. Too
 * wide burns the Vercel Hobby Active-CPU allowance, which blocks rather than
 * bills. Too narrow silently stops recording replies, which looks exactly like
 * "nobody wrote back".
 */

// Partial mocks: only the three entry points the sweeps call are replaced. The
// rest of each module stays real, so a rename anywhere in it is still a compile
// error here rather than a silently-satisfied `vi.fn()`.
vi.mock("@/lib/user-status", async (importOriginal) =>
  typedMock<typeof import("@/lib/user-status")>({
    ...(await importOriginal<typeof import("@/lib/user-status")>()),
    filterActiveUserIds: vi.fn(async (_c: unknown, ids: string[]) => new Set(ids)),
  }),
);

vi.mock("@/lib/gmail", async (importOriginal) =>
  typedMock<typeof import("@/lib/gmail")>({
    ...(await importOriginal<typeof import("@/lib/gmail")>()),
    syncAllContactEmails: vi.fn(async () => ({
      totalSynced: 0,
      processedContacts: 0,
      failedContacts: 0,
      nextCursor: null,
    })),
    syncThreadReplies: vi.fn(async () => ({ ingested: 0, learnedAddresses: 0 })),
    detectBounces: vi.fn(async () => ({
      bounced: [],
      cancelledSequences: 0,
      cancelledScheduled: 0,
      newlyBounced: [],
      alert: "no_items" as const,
    })),
  }),
);

import { getPremiumSyncUserIds, getRecentlyTouchedContactIds } from "@/lib/data/sync-targets";
import { runRecentSyncSweep, runFullSyncSweep } from "@/lib/gmail-sync-cron";
import { syncAllContactEmails, detectBounces } from "@/lib/gmail";

/** Minimal chainable PostgREST double: every filter is a no-op recorder. */
type Rows = Record<string, unknown[]>;
function makeClient(rows: Rows) {
  const seen: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {};
    const rec = (k: string) => (col: string, val?: unknown) => {
      filters[`${k}:${col}`] = val;
      return self;
    };
    Object.assign(self, {
      select: () => self,
      eq: rec("eq"),
      not: rec("not"),
      gte: rec("gte"),
      order: () => self,
      range: () => {
        seen.push({ table, filters });
        return Promise.resolve({ data: rows[table] ?? [], error: null });
      },
    });
    return self;
  };
  return { client: { from } as never, seen };
}

const PREMIUM = { user_id: "u-premium", modify_scope_granted: true, premium_enabled: true };

beforeEach(() => {
  vi.mocked(syncAllContactEmails).mockClear();
  vi.mocked(detectBounces).mockClear();
});

describe("getPremiumSyncUserIds", () => {
  it("includes a user holding mailbox:read", async () => {
    const { client } = makeClient({ gmail_connections: [PREMIUM] });
    await expect(getPremiumSyncUserIds(client)).resolves.toEqual(["u-premium"]);
  });

  it("excludes a connected user without the modify scope", async () => {
    // Free tier. Syncing them would 403 against Google, not merely cost little.
    const { client } = makeClient({
      gmail_connections: [{ user_id: "u-free", modify_scope_granted: false, premium_enabled: true }],
    });
    await expect(getPremiumSyncUserIds(client)).resolves.toEqual([]);
  });

  it("excludes a user an admin has switched off premium for", async () => {
    const { client } = makeClient({
      gmail_connections: [{ user_id: "u-off", modify_scope_granted: true, premium_enabled: false }],
    });
    await expect(getPremiumSyncUserIds(client)).resolves.toEqual([]);
  });

  it("treats a null premium_enabled as on, matching the send crons", async () => {
    // The column is an admin kill switch added later; reading its absence as
    // "off" would strand every user predating it.
    const { client } = makeClient({
      gmail_connections: [{ user_id: "u-legacy", modify_scope_granted: true, premium_enabled: null }],
    });
    await expect(getPremiumSyncUserIds(client)).resolves.toEqual(["u-legacy"]);
  });
});

describe("getRecentlyTouchedContactIds", () => {
  it("unions live sequences with recent outbound, de-duplicating the overlap", async () => {
    const { client } = makeClient({
      email_follow_ups: [{ contact_id: 1 }, { contact_id: 2 }],
      email_messages: [{ matched_contact_id: 2 }, { matched_contact_id: 3 }],
    });
    const ids = await getRecentlyTouchedContactIds(client, "u-premium");
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("scopes both legs to the user, the active status, and the date window", async () => {
    const { client, seen } = makeClient({ email_follow_ups: [], email_messages: [] });
    await getRecentlyTouchedContactIds(client, "u-premium", 9);

    const seq = seen.find((s) => s.table === "email_follow_ups")!;
    expect(seq.filters["eq:user_id"]).toBe("u-premium");
    expect(seq.filters["eq:status"]).toBe("active");

    const out = seen.find((s) => s.table === "email_messages")!;
    expect(out.filters["eq:user_id"]).toBe("u-premium");
    expect(out.filters["eq:direction"]).toBe("outbound");
    // The window is a real bound, not decoration: without it this leg becomes an
    // exhaustive sweep of the account's whole outbound history.
    const since = new Date(String(out.filters["gte:date"])).getTime();
    const expected = Date.now() - 9 * 24 * 60 * 60 * 1000;
    expect(Math.abs(since - expected)).toBeLessThan(60_000);
  });

  it("returns empty when nothing qualifies", async () => {
    const { client } = makeClient({ email_follow_ups: [], email_messages: [] });
    await expect(getRecentlyTouchedContactIds(client, "u-premium")).resolves.toEqual([]);
  });
});

describe("runRecentSyncSweep", () => {
  it("passes only the qualifying contacts down to the sync", async () => {
    const { client } = makeClient({
      gmail_connections: [PREMIUM],
      email_follow_ups: [{ contact_id: 7 }],
      email_messages: [{ matched_contact_id: 9 }],
    });

    await runRecentSyncSweep(client);

    expect(syncAllContactEmails).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(syncAllContactEmails).mock.calls[0][2]!;
    expect([...opts.contactIds!].sort((a, b) => a - b)).toEqual([7, 9]);
  });

  it("skips a user with no qualifying contacts instead of sweeping them", async () => {
    // The whole point of the narrow cadence. `.in("id", [])` matches nothing,
    // so passing an empty set down would spend a connection fetch and a pass to
    // learn there was no work — 72 times a day, per user.
    const { client } = makeClient({
      gmail_connections: [PREMIUM],
      email_follow_ups: [],
      email_messages: [],
    });

    const result = await runRecentSyncSweep(client);

    expect(syncAllContactEmails).not.toHaveBeenCalled();
    expect(result.usersSkipped).toBe(1);
    expect(result.usersCompleted).toBe(0);
  });

  it("never runs bounce detection", async () => {
    // Not contact-scoped, so at 72x/day it would cost the same as the 3x/day
    // full sweep while finding nothing the full sweep would not.
    const { client } = makeClient({
      gmail_connections: [PREMIUM],
      email_follow_ups: [{ contact_id: 7 }],
      email_messages: [],
    });

    await runRecentSyncSweep(client);
    expect(detectBounces).not.toHaveBeenCalled();
  });

  it("does not sweep a non-premium user at all", async () => {
    const { client } = makeClient({
      gmail_connections: [{ user_id: "u-free", modify_scope_granted: false, premium_enabled: true }],
      email_follow_ups: [{ contact_id: 7 }],
      email_messages: [],
    });

    const result = await runRecentSyncSweep(client);
    expect(syncAllContactEmails).not.toHaveBeenCalled();
    expect(result.users).toBe(0);
  });
});

describe("runFullSyncSweep", () => {
  it("sweeps every contact, with no contactIds narrowing", async () => {
    const { client } = makeClient({ gmail_connections: [PREMIUM] });

    await runFullSyncSweep(client);

    expect(syncAllContactEmails).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(syncAllContactEmails).mock.calls[0][2]!;
    expect(opts.contactIds).toBeUndefined();
  });

  it("runs bounce detection once the pass completes", async () => {
    const { client } = makeClient({ gmail_connections: [PREMIUM] });
    await runFullSyncSweep(client);
    expect(detectBounces).toHaveBeenCalledWith("u-premium");
  });

  it("follows the resume cursor until the contacts are exhausted", async () => {
    vi.mocked(syncAllContactEmails)
      .mockResolvedValueOnce({
        totalSynced: 3,
        processedContacts: 500,
        failedContacts: 0,
        nextCursor: 500,
      })
      .mockResolvedValueOnce({
        totalSynced: 2,
        processedContacts: 400,
        failedContacts: 0,
        nextCursor: null,
      });

    const { client } = makeClient({ gmail_connections: [PREMIUM] });
    const result = await runFullSyncSweep(client);

    expect(syncAllContactEmails).toHaveBeenCalledTimes(2);
    expect(vi.mocked(syncAllContactEmails).mock.calls[1][2]!.cursor).toBe(500);
    expect(result.totalSynced).toBe(5);
    expect(result.usersCompleted).toBe(1);
  });

  it("records a failing user without abandoning the rest of the sweep", async () => {
    vi.mocked(syncAllContactEmails)
      .mockRejectedValueOnce(new Error("Gmail not connected"))
      .mockResolvedValueOnce({
        totalSynced: 1,
        processedContacts: 1,
        failedContacts: 0,
        nextCursor: null,
      });

    const { client } = makeClient({
      gmail_connections: [
        { user_id: "u-broken", modify_scope_granted: true, premium_enabled: true },
        PREMIUM,
      ],
    });

    const result = await runFullSyncSweep(client);

    expect(result.failures).toEqual([{ userId: "u-broken", error: "Gmail not connected" }]);
    expect(result.usersCompleted).toBe(1);
  });
});
