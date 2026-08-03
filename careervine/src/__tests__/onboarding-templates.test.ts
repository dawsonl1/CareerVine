import { describe, it, expect } from "vitest";
import {
  renderOnboardingIntro,
  renderOnboardingFollowUps,
  ONBOARDING_FOLLOW_UP_DELAYS,
} from "@/lib/onboarding/templates";

const ctx = {
  contactFirstName: "Sarah",
  companyName: "Qualtrics",
  senderFirstName: "Dawson",
};

describe("renderOnboardingIntro", () => {
  it("picks the alumni variant, naming the SENDER's school", () => {
    // CAR-213: the school is the sender's, not a constant. A BYU sender still
    // gets "BYU"; a USU sender gets "USU".
    const byu = renderOnboardingIntro({ ...ctx, isAlum: true, senderSchool: "Brigham Young University" });
    expect(byu.subject).toContain("BYU");
    expect(byu.bodyHtml).toContain("fellow BYU alum");

    const usu = renderOnboardingIntro({ ...ctx, isAlum: true, senderSchool: "Utah State University" });
    expect(usu.subject).toContain("USU");
    expect(usu.bodyHtml).toContain("fellow USU alum");
    expect(usu.bodyHtml).not.toContain("BYU");
  });

  it("never claims a school the sender did not give", () => {
    // The sharpest live bug CAR-213 fixed: BOTH variants used to open "I'm a
    // student at BYU", so the variant that exists to avoid claiming a
    // connection asserted one anyway.
    for (const isAlum of [true, false]) {
      const email = renderOnboardingIntro({ ...ctx, isAlum, senderSchool: null });
      expect(email.subject).not.toMatch(/BYU|Cougar/i);
      expect(email.bodyHtml).not.toMatch(/BYU|Cougar/i);
    }
  });

  it("never claims the sender is currently a student", () => {
    // CareerVine models student-vs-professional for CONTACTS and not at all
    // for the account holder, so this was never knowable.
    const email = renderOnboardingIntro({ ...ctx, isAlum: true, senderSchool: "Brigham Young University" });
    expect(email.bodyHtml).not.toMatch(/\ba student\b/i);
    expect(email.subject).not.toMatch(/\bstudent\b/i);
  });

  it("spells out an escape-hatch school in full rather than dropping it", () => {
    // Unlike the badge, which falls back to "Alum" because a truncated name in
    // a 10px chip reads as broken, an email has room. "a fellow Pitcher
    // Institute of Technology alum" is natural, and more useful than a
    // school-less sentence.
    const email = renderOnboardingIntro({
      ...ctx, isAlum: true, senderSchool: "Pitcher Institute of Technology",
    });
    expect(email.bodyHtml).toContain("fellow Pitcher Institute of Technology alum");
    expect(email.subject).toContain("Pitcher Institute of Technology");
  });

  it("picks the general variant when not an alum", () => {
    const email = renderOnboardingIntro({ ...ctx, isAlum: false });
    expect(email.bodyHtml).not.toContain("Cougar");
    expect(email.bodyHtml).toContain("Qualtrics");
    expect(email.subject).toContain("Qualtrics");
  });

  it("merges contact, company, and sender names", () => {
    const email = renderOnboardingIntro({ ...ctx, isAlum: true });
    expect(email.bodyHtml).toContain("Hi Sarah,");
    expect(email.bodyHtml).toContain("Dawson");
  });

  it("escapes HTML in merge values", () => {
    const email = renderOnboardingIntro({
      contactFirstName: `<img src=x onerror=alert(1)>`,
      companyName: `O'Brien & Sons <Consulting>`,
      senderFirstName: "Dawson",
      isAlum: false,
    });
    expect(email.bodyHtml).not.toContain("<img");
    expect(email.bodyHtml).toContain("&lt;img");
    expect(email.bodyHtml).toContain("O&#39;Brien &amp; Sons");
    // Subject is plain text, not HTML — company must pass through unescaped.
    expect(email.subject).toContain("O'Brien & Sons <Consulting>");
  });

  it("falls back gracefully when fields are missing", () => {
    const email = renderOnboardingIntro({ isAlum: true, senderSchool: "Brigham Young University" });
    expect(email.bodyHtml).toContain("Hi there,");
    expect(email.bodyHtml).toContain("your company");
    // No dangling "I'm ," when the sender name is unknown.
    expect(email.bodyHtml).not.toContain("I'm ,");
    expect(email.bodyHtml).toContain("working toward a career in product");
  });
});

describe("renderOnboardingFollowUps", () => {
  it("returns three follow-ups a week apart — cumulative offsets from send (7/14/21)", () => {
    const followUps = renderOnboardingFollowUps(ctx);
    expect(followUps).toHaveLength(3);
    // delayDays is an absolute offset from the original send, so weekly
    // spacing means strictly increasing 7/14/21 — NOT 7/7/7, which would
    // land all three touches on the same day.
    expect(followUps.map((fu) => fu.delayDays)).toEqual([...ONBOARDING_FOLLOW_UP_DELAYS]);
    expect(followUps.map((fu) => fu.delayDays)).toEqual([7, 14, 21]);
    for (const fu of followUps) {
      expect(fu.subject.length).toBeGreaterThan(0);
      expect(fu.bodyHtml).toContain("Hi Sarah,");
    }
  });

  it("only the first follow-up references the company", () => {
    const followUps = renderOnboardingFollowUps(ctx);
    expect(followUps[0].bodyHtml).toContain("Qualtrics");
  });

  it("escapes HTML in merge values", () => {
    const followUps = renderOnboardingFollowUps({
      contactFirstName: "<b>Bob</b>",
      companyName: "Acme",
      senderFirstName: "Dawson",
    });
    expect(followUps[0].bodyHtml).toContain("&lt;b&gt;Bob&lt;/b&gt;");
    expect(followUps[0].bodyHtml).not.toContain("<b>Bob</b>");
  });
});
