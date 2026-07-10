import { describe, it, expect } from "vitest";
import {
  effectiveBundleVisibility,
  bundleVisibilityCount,
} from "@/lib/admin-bundles";

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

/**
 * List-view summary (CAR-36) — must fold each bundle through the same
 * effectiveBundleVisibility predicate the detail view and RLS use.
 */
describe("bundleVisibilityCount", () => {
  const bundles = [
    { id: 1, defaultVisible: true },
    { id: 2, defaultVisible: false },
    { id: 3, defaultVisible: true },
  ];

  it("no overrides → counts the defaults", () => {
    expect(bundleVisibilityCount(bundles, new Map())).toEqual({
      visible: 2,
      total: 3,
    });
  });

  it("grant override adds a hidden-by-default bundle", () => {
    expect(bundleVisibilityCount(bundles, new Map([[2, true]]))).toEqual({
      visible: 3,
      total: 3,
    });
  });

  it("deny override removes a visible-by-default bundle", () => {
    expect(bundleVisibilityCount(bundles, new Map([[1, false]]))).toEqual({
      visible: 1,
      total: 3,
    });
  });

  it("mixed overrides resolve per bundle", () => {
    const overrides = new Map([
      [1, false],
      [2, true],
    ]);
    expect(bundleVisibilityCount(bundles, overrides)).toEqual({
      visible: 2,
      total: 3,
    });
  });

  it("no published bundles → 0/0", () => {
    expect(bundleVisibilityCount([], new Map([[9, true]]))).toEqual({
      visible: 0,
      total: 0,
    });
  });
});
