import { describe, it, expect } from "vitest";
import { deriveNextAction, daysUntil, nextActionForCompany, NO_ACTION_RANK, type NextActionInput } from "@/lib/company-next-action";
import type { CompanySummary } from "@/lib/company-queries";

const NOW = new Date("2026-07-11T12:00:00");

function input(partial: Partial<NextActionInput>): NextActionInput {
  return {
    status: null,
    nextAppDate: null,
    traction: null,
    currentCount: 0,
    alumCount: 0,
    productAlumCount: 0,
    recruiterCount: 0,
    leadName: null,
    conversationKind: null,
    conversationAt: null,
    ...partial,
  };
}

/**
 * The ladder now returns null for a company it has nothing to say about
 * (CAR-246). Every case below expects a real action, so this narrows once and
 * fails loudly rather than making each assertion carry a `!`.
 */
function act(partial: Partial<NextActionInput>, now: Date = NOW) {
  const a = deriveNextAction(input(partial), now);
  if (!a) throw new Error(`expected a next action for ${JSON.stringify(partial)}, got null`);
  return a;
}

describe("daysUntil", () => {
  it("counts whole days from local midnight", () => {
    expect(daysUntil("2026-07-11", NOW)).toBe(0);
    expect(daysUntil("2026-07-14", NOW)).toBe(3);
    expect(daysUntil("2026-07-10", NOW)).toBe(-1);
  });
});

describe("deriveNextAction — state ladder", () => {
  it("interviewing outranks everything else", () => {
    const a = act({ status: "interviewing" }, NOW);
    expect(a.tone).toBe("urgent");
    expect(a.rank).toBe(100);
    expect(a.text).toMatch(/interviewing/i);
  });

  it("closed is inert", () => {
    const a = act({ status: "closed" }, NOW);
    expect(a.text).toBe("Closed");
    expect(a.rank).toBeLessThan(10);
  });

  it("an imminent deadline is urgent and phrased in days", () => {
    expect(act({ nextAppDate: "2026-07-11" }, NOW).text).toMatch(/today/);
    expect(act({ nextAppDate: "2026-07-12" }, NOW).text).toMatch(/tomorrow/);
    const soon = act({ nextAppDate: "2026-07-14" }, NOW);
    expect(soon.tone).toBe("urgent");
    expect(soon.text).toMatch(/in 3 days/);
  });

  it("sooner deadlines rank above later ones", () => {
    const today = act({ nextAppDate: "2026-07-11" }, NOW).rank;
    const week = act({ nextAppDate: "2026-07-18" }, NOW).rank;
    expect(today).toBeGreaterThan(week);
  });
});

describe("deriveNextAction — live threads vs deadlines", () => {
  it("orders referral > call scheduled > replied", () => {
    const referral = act({ traction: "referral" }, NOW).rank;
    const call = act({ traction: "call_scheduled" }, NOW).rank;
    const replied = act({ traction: "replied" }, NOW).rank;
    expect(referral).toBeGreaterThan(call);
    expect(call).toBeGreaterThan(replied);
  });

  it("a live reply beats a mid-range (10-day) deadline", () => {
    const replied = act({ traction: "replied", nextAppDate: "2026-07-21" }, NOW);
    // replied wins the branch — the deadline never overrides the action text.
    expect(replied.text).toMatch(/repl/i);
    expect(replied.rank).toBeGreaterThan(act({ nextAppDate: "2026-07-21" }, NOW).rank);
  });

  it("an imminent (3-day) deadline beats a live reply", () => {
    const both = act({ traction: "replied", nextAppDate: "2026-07-14" }, NOW);
    expect(both.text).toMatch(/apply/i);
    expect(both.tone).toBe("urgent");
  });

  it("names the lead by first name when there's momentum", () => {
    const a = act({ traction: "replied", leadName: "Sarah Chen" }, NOW);
    expect(a.text).toContain("Sarah");
    expect(a.text).not.toContain("Chen");
  });
});

describe("deriveNextAction — warm intros", () => {
  it("prefers an alum reach-out and names them", () => {
    const a = act({ currentCount: 3, alumCount: 1, leadName: "Mark Lee" }, NOW);
    expect(a.text).toMatch(/Mark/);
    expect(a.text).toMatch(/your alum here/i);
    expect(a.icon).toBe("GraduationCap");
  });

  it("elevates an alum in product above a plain alum and calls out the role", () => {
    const product = act({ currentCount: 2, alumCount: 1, productAlumCount: 1, leadName: "Dana Cho" }, NOW);
    const plain = act({ currentCount: 2, alumCount: 1 }, NOW);
    expect(product.text).toMatch(/in product/i);
    expect(product.text).toContain("Dana");
    expect(product.rank).toBeGreaterThan(plain.rank);
  });

  it("falls back to a generic reach-out with a count when no lead name", () => {
    const a = act({ currentCount: 4 }, NOW);
    expect(a.text).toMatch(/4 people/);
  });

  it("de-emphasizes warm-untouched: engagement outranks a cold alum reach-out", () => {
    const alum = act({ currentCount: 2, alumCount: 1 }, NOW).rank;
    const waiting = act({ traction: "contacted", currentCount: 2 }, NOW).rank;
    const replied = act({ traction: "replied", currentCount: 2 }, NOW).rank;
    // Momentum leads: anything you've already started ranks above an untouched intro.
    expect(waiting).toBeGreaterThan(alum);
    expect(replied).toBeGreaterThan(alum);
  });

  it("but a warm alum still ranks above knowing no one", () => {
    const alum = act({ currentCount: 2, alumCount: 1 }, NOW).rank;
    // Knowing nobody currently inside now produces no action at all, which the
    // "What's next" sort ranks below every real rung (CAR-246).
    const nobody = deriveNextAction(input({ status: "researching", currentCount: 0 }), NOW);
    expect(nobody).toBeNull();
    expect(alum).toBeGreaterThan(NO_ACTION_RANK);
  });
});

describe("deriveNextAction — no contacts and past due", () => {
  it("a targeted company with nobody known says nothing", () => {
    // Was "Find people who work here" (CAR-246 removed it as filler).
    expect(deriveNextAction(input({ status: "researching", currentCount: 0 }), NOW)).toBeNull();
  });

  it("a past-due deadline is surfaced, not hidden", () => {
    const a = act({ status: "researching", nextAppDate: "2026-07-01" }, NOW);
    expect(a.text).toMatch(/closed/i);
  });
});

describe("nextActionForCompany adapter", () => {
  it("maps a CompanySummary onto the ladder", () => {
    const c = {
      id: 1,
      name: "Stripe",
      logo_url: null,
      linkedin_url: null,
      current_count: 8,
      former_count: 0,
      bench_count: 0,
      alum_count: 2,
      product_alum_count: 1,
      recruiter_count: 1,
      lead_contact_name: "Sarah Chen",
      target: {
        id: 1,
        priority_score: 90,
        tier: "Tier 1",
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "outreach_active",
      },
      office_scopes: [],
      traction: "replied",
      traction_detail: { count: 1, at: "2026-07-18T00:00:00Z" },
      conversation: null,
    } satisfies CompanySummary;
    const a = nextActionForCompany(c, NOW);
    expect(a).not.toBeNull();
    expect(a!.text).toContain("Sarah");
    expect(a!.text).toMatch(/replied/i);
  });
});

describe("deriveNextAction — nothing to say (CAR-246)", () => {
  // The ladder used to always produce a line, so a company where every contact
  // had left read "Find people who work here". That is filler beside a card
  // whose own contact line already says there is nobody there. It now returns
  // null and the card renders no pill.
  //
  // The risk in that change is over-reach: "no current contacts" must silence
  // only the people-finding advice, never a fact about the application itself.
  // The cases below are the ones that would go quiet if the rule were applied
  // to the whole ladder.

  it("says nothing for a targeted company with nobody currently inside", () => {
    expect(deriveNextAction(input({ currentCount: 0 }), NOW)).toBeNull();
  });

  it("says nothing once applied if there is nobody to ask for a referral", () => {
    // The status chip already reads "Applied"; a pill repeating it and adding
    // "find someone" carried no move.
    expect(deriveNextAction(input({ status: "applied", currentCount: 0 }), NOW)).toBeNull();
  });

  it("still shows an imminent deadline to someone who knows nobody there", () => {
    const a = act({ currentCount: 0, nextAppDate: "2026-07-14" });
    expect(a.text).toMatch(/in 3 days/);
    expect(a.tone).toBe("urgent");
  });

  it("still shows a mid-range deadline, Interviewing, Closed and past-due", () => {
    expect(act({ currentCount: 0, nextAppDate: "2026-07-25" }).text).toMatch(/Apply in \d+ days/);
    expect(act({ currentCount: 0, status: "interviewing" }).text).toMatch(/interviewing/i);
    expect(act({ currentCount: 0, status: "closed" }).text).toBe("Closed");
    expect(act({ currentCount: 0, nextAppDate: "2026-06-01" }).text).toMatch(/Applications closed/);
  });

  it("still speaks when someone currently works there", () => {
    expect(deriveNextAction(input({ currentCount: 1 }), NOW)).not.toBeNull();
  });
});

describe("deriveNextAction — a conversation is not always a call (CAR-257)", () => {
  /**
   * Lucid Software's card advised "Follow up with Spencer after your call" off
   * a meeting titled "LinkedIn chat" (`meeting_type: "text"`). Every logged
   * conversation became `call_done`, and this rung read that as a phone call.
   *
   * `conversationKind` now carries the CAR-242 type down here. The two states
   * that matter most are the ends: Text and Other must not produce a follow-up
   * NUDGE at all, and an untyped conversation must still produce the original
   * one, because a Google-synced calendar event carries no type and really is
   * a call.
   */
  const done = (kind: NextActionInput["conversationKind"], at: string | null = "2026-06-11T17:00:00Z") =>
    act({ traction: "call_done", leadName: "Spencer Hintze", conversationKind: kind, conversationAt: at });

  it("keeps 'after your call' for a coffee chat", () => {
    // CAR-242 made Coffee Chat the 1:1 bucket regardless of medium, so phone
    // and video calls arrive here and nowhere else.
    expect(done("call").text).toBe("Follow up with Spencer after your call");
  });

  it("keeps 'after your call' when no type was recorded", () => {
    // The Google-synced case: calendar_events has no type column at all.
    // Silencing these would be a far worse regression than the bug being fixed.
    expect(done(null).text).toBe("Follow up with Spencer after your call");
  });

  it("names the career fair instead of a call", () => {
    const a = done("career-fair");
    expect(a.text).toBe("Follow up with Spencer after the career fair");
    expect(a.text).not.toMatch(/call/i);
    expect(a.rank).toBe(done("call").rank);
  });

  it("names the networking event instead of a call", () => {
    const a = done("networking");
    expect(a.text).toBe("Follow up with Spencer after the networking event");
    expect(a.text).not.toMatch(/call/i);
  });

  it("states the fact for a text chat instead of nudging a follow-up", () => {
    const a = done("text", "2026-06-11T17:00:00Z");
    expect(a.text).toBe("You texted Spencer 1 month ago");
    expect(a.text).not.toMatch(/follow up/i);
    expect(a.tone).toBe("muted");
  });

  it("states the fact for Other instead of nudging a follow-up", () => {
    const a = done("other", "2026-06-11T17:00:00Z");
    expect(a.text).toBe("You connected with Spencer 1 month ago");
    expect(a.text).not.toMatch(/follow up|call/i);
    expect(a.tone).toBe("muted");
  });

  it("drops the time clause rather than inventing one when the date is missing", () => {
    expect(done("text", null).text).toBe("You texted Spencer");
  });

  it("ranks a text or Other below every real move, and a real follow-up above them", () => {
    // Nothing to do, so it must not win the "What's next" sort. The warm-intro
    // band bottoms out at 34 ("Reach out, you know N people here"); a past-due
    // deadline sits at 22.
    const bareReachOut = act({ currentCount: 3, leadName: null }).rank;
    const pastDue = act({ currentCount: 0, nextAppDate: "2026-06-01" }).rank;
    for (const kind of ["text", "other"] as const) {
      expect(done(kind).rank).toBeLessThan(bareReachOut);
      expect(done(kind).rank).toBeGreaterThan(pastDue);
      expect(done("call").rank).toBeGreaterThan(done(kind).rank);
    }
  });

  it("falls back to a generic subject when there is no lead to name", () => {
    const a = act({ traction: "call_done", leadName: null, conversationKind: "text", conversationAt: "2026-06-11T17:00:00Z" });
    expect(a.text).toBe("You texted someone here 1 month ago");
  });
});

describe("deriveNextAction — a scheduled conversation is not always a call (CAR-257)", () => {
  // The same defect one rung earlier: a career fair on the calendar used to
  // read "Prep for your call".
  const soon = (kind: NextActionInput["conversationKind"]) =>
    act({ traction: "call_scheduled", leadName: "Spencer Hintze", conversationKind: kind });

  it("keeps 'your call' for a coffee chat and for an untyped event", () => {
    expect(soon("call").text).toBe("Prep for your call with Spencer");
    expect(soon(null).text).toBe("Prep for your call with Spencer");
  });

  it("preps for the event itself, not a call", () => {
    expect(soon("career-fair").text).toBe("Prep for the career fair, Spencer will be there");
    expect(soon("networking").text).toBe("Prep for the networking event, Spencer will be there");
    expect(soon("career-fair").text).not.toMatch(/call/i);
  });

  it("uses the neutral 'conversation' for a scheduled text or Other", () => {
    // You do not schedule a text exchange, so anything landing here is a
    // mislabel; a generic word is the one wording that cannot be wrong.
    expect(soon("text").text).toBe("Prep for your conversation with Spencer");
    expect(soon("other").text).toBe("Prep for your conversation with Spencer");
  });

  it("keeps every kind at the same rank as the call it replaces", () => {
    const call = soon("call").rank;
    for (const kind of ["career-fair", "networking", "text", "other"] as const) {
      expect(soon(kind).rank).toBe(call);
    }
  });
});
