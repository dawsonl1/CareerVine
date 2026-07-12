import { describe, it, expect } from "vitest";
import {
  shapeAdminUser,
  keyStatusFor,
  sanitizeSearch,
  isEffectivelyShared,
  type PublicUserRow,
} from "@/lib/admin-users";

const basePub: PublicUserRow = {
  id: "u-1",
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@profile.example",
  phone: "555-1234",
  status: "active",
  apify_enrichment_enabled: true,
  diff_analysis_enabled: true,
  discovery_enabled: false,
  created_at: "2026-01-01T00:00:00Z",
};

describe("shapeAdminUser", () => {
  it("prefers the auth email over the profile email", () => {
    const shaped = shapeAdminUser(
      basePub,
      { email: "ada@auth.example", last_sign_in_at: "2026-02-02T00:00:00Z", app_metadata: {} },
      "active",
      true,
    );
    expect(shaped.email).toBe("ada@auth.example");
    expect(shaped.lastSignInAt).toBe("2026-02-02T00:00:00Z");
  });

  it("falls back to the profile email when auth is missing", () => {
    const shaped = shapeAdminUser(basePub, undefined, "none", false);
    expect(shaped.email).toBe("ada@profile.example");
    expect(shaped.lastSignInAt).toBeNull();
    expect(shaped.isAdmin).toBe(false);
  });

  it("reflects the admin role from app_metadata", () => {
    const shaped = shapeAdminUser(basePub, { app_metadata: { role: "admin" } }, "active", false);
    expect(shaped.isAdmin).toBe(true);
  });

  it("derives the policy from the shared-access entitlement (default cutoff)", () => {
    expect(shapeAdminUser(basePub, undefined, "none", true).aiFallbackPolicy).toBe("shared");
    expect(shapeAdminUser(basePub, undefined, "none", false).aiFallbackPolicy).toBe("cutoff");
  });

  it("carries the Apify kill switches through (plan 36)", () => {
    const on = shapeAdminUser(basePub, undefined, "none", false);
    expect(on.apifyEnrichmentEnabled).toBe(true);
    expect(on.diffAnalysisEnabled).toBe(true);
    const off = shapeAdminUser(
      { ...basePub, apify_enrichment_enabled: false, diff_analysis_enabled: false },
      undefined,
      "none",
      false,
    );
    expect(off.apifyEnrichmentEnabled).toBe(false);
    expect(off.diffAnalysisEnabled).toBe(false);
  });

  it("carries the discovery switch through (plan 41, default off)", () => {
    expect(shapeAdminUser(basePub, undefined, "none", false).discoveryEnabled).toBe(false);
    expect(
      shapeAdminUser({ ...basePub, discovery_enabled: true }, undefined, "none", false).discoveryEnabled,
    ).toBe(true);
  });

  it("carries status, phone, and key status through", () => {
    const shaped = shapeAdminUser(
      { ...basePub, status: "suspended" },
      undefined,
      "quota_exceeded",
      false,
    );
    expect(shaped.status).toBe("suspended");
    expect(shaped.phone).toBe("555-1234");
    expect(shaped.keyStatus).toBe("quota_exceeded");
  });

  it("defaults empty names to blank strings", () => {
    const shaped = shapeAdminUser(
      { ...basePub, first_name: null, last_name: null },
      undefined,
      "none",
      false,
    );
    expect(shaped.firstName).toBe("");
    expect(shaped.lastName).toBe("");
  });

  it("defaults the CAR-103 entitlement fields to false without a gmail connection", () => {
    const shaped = shapeAdminUser(basePub, undefined, "none", false);
    expect(shaped.automaticFeaturesEnabled).toBe(false);
    expect(shaped.modifyScopeGranted).toBe(false);
    expect(shaped.hasGmailConnection).toBe(false);
  });

  it("carries the CAR-103 entitlement flags from the gmail connection", () => {
    const shaped = shapeAdminUser(basePub, undefined, "none", false, {
      automatic_features_enabled: true,
      modify_scope_granted: true,
    });
    expect(shaped.automaticFeaturesEnabled).toBe(true);
    expect(shaped.modifyScopeGranted).toBe(true);
    expect(shaped.hasGmailConnection).toBe(true);
  });
});

describe("isEffectivelyShared (CAR-51)", () => {
  const FUTURE = new Date(Date.now() + 60_000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  it("treats a permanent grant (null expiry) as shared", () => {
    expect(isEffectivelyShared({ shared_access: true, expires_at: null })).toBe(true);
  });

  it("treats an active trial as shared and an expired one as not", () => {
    expect(isEffectivelyShared({ shared_access: true, expires_at: FUTURE })).toBe(true);
    // Stale row: window closed but the lazy flip hasn't run yet.
    expect(isEffectivelyShared({ shared_access: true, expires_at: PAST })).toBe(false);
  });

  it("treats cutoffs and missing rows as not shared", () => {
    expect(isEffectivelyShared({ shared_access: false, expires_at: null })).toBe(false);
    expect(isEffectivelyShared(null)).toBe(false);
    expect(isEffectivelyShared(undefined)).toBe(false);
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
