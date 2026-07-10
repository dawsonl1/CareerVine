import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseEnv: () => ({ url: "https://test.supabase.co" }),
}));

import { getAppOrigin, getMcpResourceUrl, getSupabaseAuthIssuer } from "../auth-config";

describe("mcp auth-config", () => {
  it("uses www canonical origin by default", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getAppOrigin()).toBe("https://www.careervine.app");
    expect(getMcpResourceUrl()).toBe("https://www.careervine.app/api/mcp");
  });

  it("derives Supabase issuer with /auth/v1 path", () => {
    expect(getSupabaseAuthIssuer()).toBe("https://test.supabase.co/auth/v1");
  });
});
