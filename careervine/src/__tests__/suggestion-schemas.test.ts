import { describe, it, expect } from "vitest";
import { suggestionsSaveSchema } from "@/lib/api-schemas";

function expectValid(schema: any, data: unknown) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Expected valid but got: ${JSON.stringify(result.error.issues)}`);
  }
}

function expectInvalid(schema: any, data: unknown) {
  const result = schema.safeParse(data);
  expect(result.success).toBe(false);
}

describe("suggestionsSaveSchema", () => {
  const validPayload = {
    contactId: 42,
    title: "Follow up with Sarah about Stripe",
    description: "Ask how her first month is going",
    reasonType: "llm_personalized",
    headline: "Sarah mentioned starting at Stripe",
    evidence: "she said she was excited about joining the payments team",
  };

  it("accepts a valid full payload", () => {
    expectValid(suggestionsSaveSchema, validPayload);
  });

  it("accepts payload without optional description", () => {
    const { description, ...without } = validPayload;
    expectValid(suggestionsSaveSchema, without);
  });

  it("rejects missing contactId", () => {
    const { contactId, ...without } = validPayload;
    expectInvalid(suggestionsSaveSchema, without);
  });

  it("rejects missing title", () => {
    const { title, ...without } = validPayload;
    expectInvalid(suggestionsSaveSchema, without);
  });

  it("rejects empty title", () => {
    expectInvalid(suggestionsSaveSchema, { ...validPayload, title: "" });
  });

  it("rejects missing reasonType", () => {
    const { reasonType, ...without } = validPayload;
    expectInvalid(suggestionsSaveSchema, without);
  });

  it("rejects missing headline", () => {
    const { headline, ...without } = validPayload;
    expectInvalid(suggestionsSaveSchema, without);
  });

  it("rejects missing evidence", () => {
    const { evidence, ...without } = validPayload;
    expectInvalid(suggestionsSaveSchema, without);
  });

  it("rejects non-integer contactId", () => {
    expectInvalid(suggestionsSaveSchema, { ...validPayload, contactId: 42.5 });
  });

  it("rejects string contactId", () => {
    expectInvalid(suggestionsSaveSchema, { ...validPayload, contactId: "42" });
  });
});
