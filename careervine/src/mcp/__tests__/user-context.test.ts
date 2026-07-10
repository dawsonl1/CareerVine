import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: () => ({}) }),
}));
vi.mock("@/lib/company-queries", () => ({ setCompanyQueriesClient: () => {} }));

import { initDb, uid } from "../lib/db";
import { runWithUser, runWithUserAsync, requireRequestUserId } from "../user-context";

const USER_A = "user-a";
const USER_B = "user-b";

describe("mcp user context", () => {
  beforeEach(() => {
    initDb(USER_A);
  });

  it("stdio fallback works when ALS is unset", () => {
    expect(uid()).toBe(USER_A);
    expect(() => requireRequestUserId()).toThrow(/no authenticated user/);
  });

  it("runWithUser overrides stdio fallback for uid()", () => {
    runWithUser(USER_B, () => {
      expect(uid()).toBe(USER_B);
    });
    expect(uid()).toBe(USER_A);
  });

  it("interleaved async contexts do not leak user ids", async () => {
    const results = await Promise.all([
      runWithUserAsync(USER_A, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return uid();
      }),
      runWithUserAsync(USER_B, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return uid();
      }),
    ]);
    expect(results).toEqual([USER_A, USER_B]);
  });
});
