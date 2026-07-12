import { describe, it, expect, beforeEach } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/notify/tokens";

/**
 * Unsubscribe HMAC tokens (CAR-105). The unauthenticated opt-out route trusts
 * only what this verifies, so forgery resistance and exact round-tripping matter.
 */

beforeEach(() => {
  process.env.NUDGE_UNSUBSCRIBE_SECRET = "test-secret-value";
});

describe("unsubscribe tokens", () => {
  it("round-trips a signed token back to its userId + purpose", () => {
    const token = signUnsubscribeToken("user-123", "followup_nudges");
    expect(verifyUnsubscribeToken(token)).toEqual({
      userId: "user-123",
      purpose: "followup_nudges",
    });
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken("user-123", "followup_nudges");
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubscribeToken("user-123", "followup_nudges");
    process.env.NUDGE_UNSUBSCRIBE_SECRET = "a-different-secret";
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects a swapped userId (signature no longer matches payload)", () => {
    const token = signUnsubscribeToken("user-123", "followup_nudges");
    const sig = token.split(".")[2];
    const forged = `user-999.followup_nudges.${sig}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it("rejects an unknown purpose", () => {
    // Hand-craft a structurally valid 3-part token with a bad purpose.
    expect(verifyUnsubscribeToken("user-1.some_other_purpose.sig")).toBeNull();
  });

  it("rejects malformed tokens (wrong part count)", () => {
    expect(verifyUnsubscribeToken("only-one-part")).toBeNull();
    expect(verifyUnsubscribeToken("two.parts")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });
});
