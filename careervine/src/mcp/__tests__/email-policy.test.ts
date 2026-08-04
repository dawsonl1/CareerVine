import { describe, it, expect } from "vitest";
import { resolveRecipient, UnverifiedAddressError, type EmailRowLike } from "../lib/email-policy";

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

  // CAR-217 replaced the old "accepts an unknown override with a warning" test.
  // That behavior is the bug: an agent guessed three first.last@google.com
  // addresses, got exactly that warning on each, sent anyway, and reported all
  // three as delivered. Two bounced. A warning beside a success payload does not
  // stop an LLM; a thrown error does.
  describe("unverified override", () => {
    it("REFUSES an address the contact does not have", () => {
      expect(() => resolveRecipient("Jane", [row("a@x.com")], "other@y.com")).toThrow(
        UnverifiedAddressError,
      );
    });

    it("names the saved addresses so the caller can self-correct", () => {
      expect(() => resolveRecipient("Jane", [row("a@x.com")], "other@y.com")).toThrow(
        /Saved addresses: a@x\.com/,
      );
    });

    it("tells a contact with no saved addresses apart from one with some", () => {
      expect(() => resolveRecipient("Jane", [], "other@y.com")).toThrow(/Jane has no saved addresses/);
    });

    it("allows it through only when the caller explicitly opts in", () => {
      const r = resolveRecipient("Jane", [row("a@x.com")], "other@y.com", { allowUnverified: true });
      expect(r.email).toBe("other@y.com");
      expect(r.warnings.some((w) => w.includes("allow_unverified_address was set"))).toBe(true);
    });

    it("still refuses a KNOWN address that has bounced, opt-in or not", () => {
      // The opt-in is for addresses CareerVine has never seen, not a way to
      // override a recorded delivery failure.
      const emails = [row("dead@x.com", { bounced_at: "2026-08-01T00:00:00Z" })];
      expect(() => resolveRecipient("Jane", emails, "dead@x.com", { allowUnverified: true })).toThrow(
        /bounced/,
      );
    });

    it("does not require the opt-in for an address the contact DOES have", () => {
      const r = resolveRecipient("Jane", [row("a@x.com"), row("b@x.com")], "b@x.com");
      expect(r.email).toBe("b@x.com");
      expect(r.warnings).toEqual([]);
    });

    it("matches a saved address case-insensitively rather than calling it a guess", () => {
      const r = resolveRecipient("Jane", [row("a@x.com")], "A@X.COM");
      expect(r.email).toBe("a@x.com");
    });
  });
});
