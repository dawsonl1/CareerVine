// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { trackPathForBackNav, hasInAppBackHistory } from "@/lib/nav-history";

describe("nav-history", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no back history on a cold landing", () => {
    trackPathForBackNav("/contacts");
    expect(hasInAppBackHistory()).toBe(false);
  });

  it("reports back history once a second, different page is visited", () => {
    trackPathForBackNav("/contacts");
    trackPathForBackNav("/contacts/42");
    expect(hasInAppBackHistory()).toBe(true);
  });

  it("does not treat a re-render of the same path as navigation", () => {
    trackPathForBackNav("/contacts");
    trackPathForBackNav("/contacts");
    trackPathForBackNav("/contacts");
    expect(hasInAppBackHistory()).toBe(false);
  });

  it("keeps only the immediately previous page as the back target", () => {
    trackPathForBackNav("/home");
    trackPathForBackNav("/contacts");
    trackPathForBackNav("/contacts/42");
    expect(sessionStorage.getItem("cv:nav:previous")).toBe("/contacts");
    expect(sessionStorage.getItem("cv:nav:current")).toBe("/contacts/42");
  });

  it("falls back to no back history when sessionStorage reads throw", () => {
    // Private-browsing modes throw on access rather than returning null. The
    // affordance must degrade to "no in-app back", not crash the page.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is disabled");
    });
    expect(hasInAppBackHistory()).toBe(false);
  });

  it("does not throw when sessionStorage writes are blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => trackPathForBackNav("/contacts")).not.toThrow();
  });
});
