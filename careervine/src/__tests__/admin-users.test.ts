import { describe, it, expect } from "vitest";
import {
  shapeAdminUser,
  keyStatusFor,
  sanitizeSearch,
  type PublicUserRow,
} from "@/lib/admin-users";

const basePub: PublicUserRow = {
  id: "u-1",
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@profile.example",
  phone: "555-1234",
  status: "active",
  ai_fallback_policy: "shared",
  created_at: "2026-01-01T00:00:00Z",
};

describe("shapeAdminUser", () => {
  it("prefers the auth email over the profile email", () => {
    const shaped = shapeAdminUser(
      basePub,
      { email: "ada@auth.example", last_sign_in_at: "2026-02-02T00:00:00Z", app_metadata: {} },
      "active",
    );
    expect(shaped.email).toBe("ada@auth.example");
    expect(shaped.lastSignInAt).toBe("2026-02-02T00:00:00Z");
  });

  it("falls back to the profile email when auth is missing", () => {
    const shaped = shapeAdminUser(basePub, undefined, "none");
    expect(shaped.email).toBe("ada@profile.example");
    expect(shaped.lastSignInAt).toBeNull();
    expect(shaped.isAdmin).toBe(false);
  });

  it("reflects the admin role from app_metadata", () => {
    const shaped = shapeAdminUser(basePub, { app_metadata: { role: "admin" } }, "active");
    expect(shaped.isAdmin).toBe(true);
  });

  it("carries status, policy, phone, and key status through", () => {
    const shaped = shapeAdminUser(
      { ...basePub, status: "suspended", ai_fallback_policy: "cutoff" },
      undefined,
      "quota_exceeded",
    );
    expect(shaped.status).toBe("suspended");
    expect(shaped.aiFallbackPolicy).toBe("cutoff");
    expect(shaped.phone).toBe("555-1234");
    expect(shaped.keyStatus).toBe("quota_exceeded");
  });

  it("defaults empty names to blank strings", () => {
    const shaped = shapeAdminUser(
      { ...basePub, first_name: null, last_name: null },
      undefined,
      "none",
    );
    expect(shaped.firstName).toBe("");
    expect(shaped.lastName).toBe("");
  });
});

describe("keyStatusFor", () => {
  it("passes through known statuses", () => {
    expect(keyStatusFor("active")).toBe("active");
    expect(keyStatusFor("invalid")).toBe("invalid");
    expect(keyStatusFor("quota_exceeded")).toBe("quota_exceeded");
  });

  it("maps missing / unknown to 'none'", () => {
    expect(keyStatusFor(null)).toBe("none");
    expect(keyStatusFor(undefined)).toBe("none");
    expect(keyStatusFor("weird")).toBe("none");
  });
});

describe("sanitizeSearch", () => {
  it("strips characters that would break a PostgREST or() filter", () => {
    const out = sanitizeSearch("a,b(c)%*d");
    expect(out).not.toMatch(/[,()%*]/);
    expect(out).toContain("a");
    expect(out).toContain("d");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSearch("  ada  ")).toBe("ada");
  });
});
