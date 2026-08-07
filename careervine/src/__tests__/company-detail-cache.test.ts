import { describe, it, expect, beforeEach } from "vitest";
import { readList, writeList, resetListCache } from "@/lib/list-cache";
import {
  COMPANY_SCOPES_TTL_MS,
  companyScopesKey,
  companyScopesKeyPrefix,
  invalidateCompanyScopes,
} from "@/lib/company-detail-cache";

/**
 * CAR-268. The company roster is cached per company, but invalidated across ALL
 * of them, and that asymmetry is the whole point: a contact holds roles at
 * several companies and no write site knows which rosters they appear on.
 */

beforeEach(resetListCache);

describe("company scopes cache identity", () => {
  it("keys per company under a per-user prefix", () => {
    expect(companyScopesKey("u-1", 42)).toBe("company-scopes:u-1:42");
    expect(companyScopesKey("u-1", 42).startsWith(companyScopesKeyPrefix("u-1"))).toBe(true);
    expect(companyScopesKey("u-1", 7)).not.toBe(companyScopesKey("u-1", 42));
    expect(companyScopesKey("u-2", 42)).not.toBe(companyScopesKey("u-1", 42));
  });

  it("invalidates EVERY cached company, not just one", () => {
    // The failure this prevents: edit a contact who works at two companies,
    // then open the other one and see the version you just replaced.
    writeList(companyScopesKey("u-1", 1), { roster: "a" }, 0);
    writeList(companyScopesKey("u-1", 2), { roster: "b" }, 0);

    invalidateCompanyScopes();

    expect(readList(companyScopesKey("u-1", 1), COMPANY_SCOPES_TTL_MS, 0)).toBeUndefined();
    expect(readList(companyScopesKey("u-1", 2), COMPANY_SCOPES_TTL_MS, 0)).toBeUndefined();
  });

  it("leaves other caches alone", () => {
    // Over-invalidating within its own prefix is deliberate; reaching outside it
    // would silently make the companies LIST refetch on every contact edit.
    writeList(companyScopesKey("u-1", 1), { roster: "a" }, 0);
    writeList("companies:u-1:next", ["list"], 0);

    invalidateCompanyScopes();

    expect(readList(companyScopesKey("u-1", 1), COMPANY_SCOPES_TTL_MS, 0)).toBeUndefined();
    expect(readList("companies:u-1:next", COMPANY_SCOPES_TTL_MS, 0)).toEqual(["list"]);
  });

  it("expires on a TTL shorter than the list's", () => {
    // Several writers that touch these tables are other processes (Gmail and
    // calendar sync, the Apify re-scrape webhook, MCP) with no client site to
    // invalidate from. For those the TTL is the only bound, so it is tighter.
    expect(COMPANY_SCOPES_TTL_MS).toBeLessThan(5 * 60 * 1000);

    writeList(companyScopesKey("u-1", 1), { roster: "a" }, 1_000);
    expect(
      readList(companyScopesKey("u-1", 1), COMPANY_SCOPES_TTL_MS, 1_000 + COMPANY_SCOPES_TTL_MS + 1),
    ).toBeUndefined();
  });
});
