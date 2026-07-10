import { describe, it, expect } from "vitest";
import {
  parseAiFailure,
  isAiFailureCode,
  AI_FAILURE_COPY,
  AI_UNAVAILABLE_STATUS,
} from "@/lib/ai-errors";

describe("parseAiFailure", () => {
  it("returns the code for a 402 with a known code", () => {
    expect(parseAiFailure(402, { error: "x", code: "ai_no_key" })).toBe("ai_no_key");
    expect(parseAiFailure(402, { code: "ai_key_invalid" })).toBe("ai_key_invalid");
    expect(parseAiFailure(402, { code: "ai_quota_exhausted" })).toBe("ai_quota_exhausted");
    expect(parseAiFailure(402, { code: "ai_unavailable" })).toBe("ai_unavailable");
  });

  it("treats a 402 with a missing/unknown code as ai_unavailable (defensive)", () => {
    expect(parseAiFailure(402, {})).toBe("ai_unavailable");
    expect(parseAiFailure(402, null)).toBe("ai_unavailable");
    expect(parseAiFailure(402, { code: "something_else" })).toBe("ai_unavailable");
  });

  it("returns null for non-402 responses even if a code is present", () => {
    expect(parseAiFailure(500, { code: "ai_no_key" })).toBeNull();
    expect(parseAiFailure(400, { error: "bad request" })).toBeNull();
    expect(parseAiFailure(200, { ok: true })).toBeNull();
  });
});

describe("isAiFailureCode", () => {
  it("narrows only the known codes", () => {
    expect(isAiFailureCode("ai_no_key")).toBe(true);
    expect(isAiFailureCode("ai_unavailable")).toBe(true);
    expect(isAiFailureCode("nope")).toBe(false);
    expect(isAiFailureCode(undefined)).toBe(false);
    expect(isAiFailureCode(402)).toBe(false);
  });
});

describe("AI_FAILURE_COPY", () => {
  it("has complete, settings-linked copy for every code", () => {
    for (const code of ["ai_no_key", "ai_key_invalid", "ai_quota_exhausted", "ai_unavailable"] as const) {
      const copy = AI_FAILURE_COPY[code];
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.ctaLabel.length).toBeGreaterThan(0);
      expect(copy.ctaHref).toBe("/settings?tab=ai");
      expect(copy.serverMessage).not.toMatch(/sk-/);
    }
  });

  it("marks only ai_unavailable as retryable", () => {
    expect(AI_FAILURE_COPY.ai_unavailable.retryable).toBe(true);
    expect(AI_FAILURE_COPY.ai_no_key.retryable).toBe(false);
    expect(AI_FAILURE_COPY.ai_key_invalid.retryable).toBe(false);
    expect(AI_FAILURE_COPY.ai_quota_exhausted.retryable).toBe(false);
  });

  it("uses HTTP 402 as the availability status", () => {
    expect(AI_UNAVAILABLE_STATUS).toBe(402);
  });
});
