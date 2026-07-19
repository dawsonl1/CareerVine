import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-109: adding a contact with an email should fetch that person's prior Gmail
 * history so pre-existing correspondence appears on their profile — but ONLY for
 * paid accounts (mailbox:read). Free-tier connections hold only gmail.send and
 * have no inbox read scope (CAR-102), so nothing must be fetched for them.
 */

let caps = new Set<string>();
let conn: { gmail_address: string } | null = { gmail_address: "me@gmail.com" };
const syncSpy = vi.fn<(...a: unknown[]) => Promise<number>>(async () => 3);

vi.mock("@/lib/gmail-send-core", () => ({
  getConnection: vi.fn(async () => conn),
}));

vi.mock("@/lib/gmail", () => ({
  syncEmailsForContact: (...a: unknown[]) => syncSpy(...a),
}));

vi.mock("@/lib/capabilities/resolve", () => ({
  resolveCapabilities: vi.fn(async () => caps),
}));

import { syncContactEmailHistoryIfPaid } from "@/lib/contact-email-history";

describe("syncContactEmailHistoryIfPaid — paid-tier gating (CAR-109)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    caps = new Set();
    conn = { gmail_address: "me@gmail.com" };
  });

  it("paid tier (mailbox:read) + connected -> fetches the contact's history", async () => {
    caps = new Set(["mailbox:read"]);
    const n = await syncContactEmailHistoryIfPaid("u-1", 5, ["jane@corp.com"]);
    // 4th arg is the alias-aware own-address list (CAR-153/R2.5).
    expect(syncSpy).toHaveBeenCalledWith("u-1", 5, ["jane@corp.com"], ["me@gmail.com"], 90);
    expect(n).toBe(3);
  });

  it("free tier (no mailbox:read) -> never touches Gmail", async () => {
    caps = new Set(["outreach:portal"]);
    const n = await syncContactEmailHistoryIfPaid("u-1", 5, ["jane@corp.com"]);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("paid tier but Gmail not connected -> no fetch", async () => {
    caps = new Set(["mailbox:read"]);
    conn = null;
    const n = await syncContactEmailHistoryIfPaid("u-1", 5, ["jane@corp.com"]);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("no email addresses -> no fetch (and no capability check needed)", async () => {
    caps = new Set(["mailbox:read"]);
    const n = await syncContactEmailHistoryIfPaid("u-1", 5, []);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});
