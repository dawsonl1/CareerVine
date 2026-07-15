import { describe, it, expect } from "vitest";
import { shouldRequestGmailModifyScope } from "@/lib/gmail-modify-scope";

describe("shouldRequestGmailModifyScope (CAR-131)", () => {
  it("preserves modify for premium users who already hold it", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: true,
        premiumEnabled: true,
      }),
    ).toBe(true);
  });

  it("does not request modify when admin turned Premium off", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: true,
        premiumEnabled: false,
      }),
    ).toBe(false);
  });

  it("null premiumEnabled defaults to on (legacy)", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: true,
        premiumEnabled: null,
      }),
    ).toBe(true);
  });

  it("free connected (no modify, no upgrade flag) stays sensitive-only", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: false,
        premiumEnabled: true,
      }),
    ).toBe(false);
  });

  it("upgrade reconnect with Premium on requests modify", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: false,
        premiumEnabled: true,
        upgradeRequested: true,
      }),
    ).toBe(true);
  });

  it("upgrade reconnect with Premium off does not request modify", () => {
    expect(
      shouldRequestGmailModifyScope({
        modifyScopeGranted: false,
        premiumEnabled: false,
        upgradeRequested: true,
      }),
    ).toBe(false);
  });
});
