import { describe, it, expect } from "vitest";
import { renderNudgeDigest, type NudgeItem } from "@/app/api/cron/follow-up-nudges/digest";

/**
 * The nudge digest template (CAR-105) is a pure function, so its copy and
 * escaping are testable on their own. Guards: stage-agnostic subject, singular
 * vs plural, HTML-escaped user data, both links present, and rule 35 (no em
 * dashes in anything a user reads).
 */

const APP = "https://www.careervine.app";
const UNSUB = "https://www.careervine.app/api/notifications/unsubscribe?token=abc.followup_nudges.sig";

function items(n: number): NudgeItem[] {
  return Array.from({ length: n }, (_, i) => ({
    contactName: `Contact ${i}`,
    subject: `Subject ${i}`,
  }));
}

describe("renderNudgeDigest (CAR-105)", () => {
  it("uses a singular, stage-agnostic subject for one item", () => {
    const { subject } = renderNudgeDigest(items(1), APP, UNSUB);
    expect(subject).toBe("You have a follow-up awaiting your review");
  });

  it("pluralizes and counts for multiple items", () => {
    const { subject } = renderNudgeDigest(items(3), APP, UNSUB);
    expect(subject).toBe("You have 3 follow-ups awaiting your review");
  });

  it("lists every item's contact + subject in html and text", () => {
    const { html, text } = renderNudgeDigest(items(2), APP, UNSUB);
    for (const label of ["Contact 0", "Subject 0", "Contact 1", "Subject 1"]) {
      expect(html).toContain(label);
      expect(text).toContain(label);
    }
  });

  it("escapes HTML in user-controlled fields (no injection)", () => {
    const { html } = renderNudgeDigest(
      [{ contactName: `<script>x</script>`, subject: `A & B "quote"` }],
      APP,
      UNSUB,
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("points the review CTA at /inbox (where the follow-up review UI lives), not /outreach", () => {
    const { html, text } = renderNudgeDigest(items(1), APP, UNSUB);
    // /inbox renders the follow-up review UI (OutreachShell / Follow-ups tab);
    // /outreach is the company-stepping queue and shows none of these (CAR-139).
    expect(html).toContain(`${APP}/inbox`);
    expect(html).not.toContain(`${APP}/outreach`);
    expect(html).toContain(UNSUB);
    expect(text).toContain(`${APP}/inbox`);
    expect(text).not.toContain(`${APP}/outreach`);
    expect(text).toContain(UNSUB);
  });

  it("contains no em dashes anywhere a user reads (rule 35)", () => {
    const { subject, html, text } = renderNudgeDigest(items(2), APP, UNSUB);
    expect(subject).not.toContain("—");
    expect(html).not.toContain("—");
    expect(text).not.toContain("—");
  });
});
