import { describe, it, expect } from "vitest";
import { aiFollowUpGenerateSchema, aiFollowUpPatchSchema } from "@/lib/api-schemas";

describe("aiFollowUpGenerateSchema", () => {
  it("accepts valid contactIds array", () => {
    const result = aiFollowUpGenerateSchema.safeParse({ contactIds: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it("rejects empty contactIds", () => {
    const result = aiFollowUpGenerateSchema.safeParse({ contactIds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than 3 contactIds", () => {
    const result = aiFollowUpGenerateSchema.safeParse({ contactIds: [1, 2, 3, 4] });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer contactIds", () => {
    const result = aiFollowUpGenerateSchema.safeParse({ contactIds: [1.5] });
    expect(result.success).toBe(false);
  });

  it("rejects missing contactIds", () => {
    const result = aiFollowUpGenerateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("aiFollowUpPatchSchema", () => {
  it("accepts valid status update", () => {
    const result = aiFollowUpPatchSchema.safeParse({ status: "dismissed" });
    expect(result.success).toBe(true);
  });

  it("accepts sent status", () => {
    const result = aiFollowUpPatchSchema.safeParse({ status: "sent" });
    expect(result.success).toBe(true);
  });

  it("accepts edited_and_sent status", () => {
    const result = aiFollowUpPatchSchema.safeParse({ status: "edited_and_sent" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = aiFollowUpPatchSchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts body/subject updates", () => {
    const result = aiFollowUpPatchSchema.safeParse({
      subject: "New subject",
      bodyHtml: "<p>New body</p>",
    });
    expect(result.success).toBe(true);
  });

  it("accepts sendAsReply toggle", () => {
    const result = aiFollowUpPatchSchema.safeParse({ sendAsReply: true });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no updates)", () => {
    const result = aiFollowUpPatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
