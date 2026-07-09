import { describe, it, expect } from "vitest";
import { effectiveBundleVisibility } from "@/lib/admin-bundles";

/**
 * Mirror of the SQL bundle_visible_to() predicate — the two must agree.
 * Truth table: explicit override wins (deny beats grant is moot per-user
 * since one row per (user,bundle)), else the bundle default.
 */
describe("effectiveBundleVisibility", () => {
  it("no override → bundle default decides", () => {
    expect(effectiveBundleVisibility(true, null)).toBe(true);
    expect(effectiveBundleVisibility(false, null)).toBe(false);
  });

  it("grant override shows a hidden-by-default bundle", () => {
    expect(effectiveBundleVisibility(false, true)).toBe(true);
  });

  it("deny override hides a visible-by-default bundle", () => {
    expect(effectiveBundleVisibility(true, false)).toBe(false);
  });

  it("override matching the default is still honored", () => {
    expect(effectiveBundleVisibility(true, true)).toBe(true);
    expect(effectiveBundleVisibility(false, false)).toBe(false);
  });
});
