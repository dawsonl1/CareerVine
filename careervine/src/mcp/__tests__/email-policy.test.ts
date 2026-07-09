import { describe, it, expect } from "vitest";
import { resolveRecipient, type EmailRowLike } from "../lib/email-policy";

const row = (email: string, over: Partial<EmailRowLike> = {}): EmailRowLike => ({
  email,
  is_primary: false,
  source: "manual",
  bounced_at: null,
  ...over,
});

describe("resolveRecipient", () => {
  it("picks the primary address by default", () => {
    const r = resolveRecipient("Jane", [row("a@x.com"), row("B@x.com", { is_primary: true })]);
    expect(r.email).toBe("b@x.com");
    expect(r.warnings).toEqual([]);
  });

  it("falls back to the first usable address when nothing is primary", () => {
    expect(resolveRecipient("Jane", [row("a@x.com"), row("b@x.com")]).email).toBe("a@x.com");
  });

  it("skips bounced addresses when picking a default", () => {
    const r = resolveRecipient("Jane", [
      row("dead@x.com", { is_primary: true, bounced_at: "2026-01-01" }),
      row("alive@x.com"),
    ]);
    expect(r.email).toBe("alive@x.com");
  });

  it("refuses when every address has bounced", () => {
    expect(() =>
      resolveRecipient("Jane", [row("dead@x.com", { bounced_at: "2026-01-01" })]),
    ).toThrow(/bounced/);
  });

  it("refuses a bounced override outright", () => {
    expect(() =>
      resolveRecipient("Jane", [row("dead@x.com", { bounced_at: "2026-01-01" })], "dead@x.com"),
    ).toThrow(/bounced/);
  });

  it("throws when the contact has no email", () => {
    expect(() => resolveRecipient("Jane", [])).toThrow(/no email address/);
  });

  it("warns on pattern-guessed addresses but still resolves", () => {
    const r = resolveRecipient("Jane", [row("guess@x.com", { source: "pattern_guessed" })]);
    expect(r.email).toBe("guess@x.com");
    expect(r.warnings.some((w) => w.includes("pattern-guessed"))).toBe(true);
  });

  it("accepts an unknown override with a warning", () => {
    const r = resolveRecipient("Jane", [row("a@x.com")], "other@y.com");
    expect(r.email).toBe("other@y.com");
    expect(r.warnings.some((w) => w.includes("not one of Jane's saved addresses"))).toBe(true);
  });
});
