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
    lastOutreachAt: null,
    replyThread: null,
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

/**
 * "<name> replied, write back" used to fire on `traction === "replied"` alone,
 * and that stage is sticky — once someone has ever written back it stays true
 * forever. So the card kept issuing a standing instruction on threads whose
 * last word was already ours (CAR-253).
 *
 * The rule is per-thread and anchored on their FIRST reply: anything we sent
 * after it retires the prompt permanently.
 */
describe("deriveNextAction — a reply you already answered (CAR-253)", () => {
  const unanswered = { awaitingOurReply: true, lastMessageAt: "2026-07-09T10:00:00Z" };
  const answered = { awaitingOurReply: false, lastMessageAt: "2026-07-09T10:00:00Z" };

  it("still says write back while the reply is unanswered", () => {
    const a = act({ traction: "replied", leadName: "Samuel Diaz", replyThread: unanswered }, NOW);
    expect(a.text).toBe("Samuel replied, write back");
    expect(a.rank).toBe(84);
  });

  it("switches to a past-tense line once we have written back, and dates it", () => {
    const a = act({ traction: "replied", leadName: "Samuel Diaz", replyThread: answered }, NOW);
    expect(a.text).toBe("You had an email thread with Samuel (2 days ago)");
    expect(a.text).not.toMatch(/write back/i);
    expect(a.tone).toBe("muted");
  });

  it("stays past-tense after they reply AGAIN, because we already answered once", () => {
    // Dawson's case verbatim: they wrote, we wrote back, they wrote again. The
    // data layer reports awaitingOurReply false (it anchors on the FIRST reply),
    // and the ladder must not re-issue the instruction on the newer message.
    const theyRepliedAgain = { awaitingOurReply: false, lastMessageAt: "2026-07-10T10:00:00Z" };
    const a = act({ traction: "replied", leadName: "Samuel Diaz", replyThread: theyRepliedAgain }, NOW);
    expect(a.text).toBe("You had an email thread with Samuel (yesterday)");
  });

  it("drops the answered thread down beside 'waiting on them', not up with live replies", () => {
    const owed = act({ traction: "replied", replyThread: unanswered }, NOW).rank;
    const done = act({ traction: "replied", replyThread: answered }, NOW).rank;
    const waiting = act({ traction: "contacted" }, NOW).rank;
    const cold = act({ currentCount: 2, alumCount: 1 }, NOW).rank;
    expect(owed).toBeGreaterThan(done);
    expect(done).toBeGreaterThan(waiting);
    // Still momentum, so it beats an untouched warm intro.
    expect(waiting).toBeGreaterThan(cold);
  });

  it("lets a mid-range deadline outrank an answered thread", () => {
    const a = act({ traction: "replied", replyThread: answered, nextAppDate: "2026-07-21" }, NOW);
    expect(a.text).toMatch(/^Apply in \d+ days/);
  });

  it("assumes a write-back is owed when nothing is known about the thread", () => {
    // A stage_override of "replied" has no message behind it. Prompting for a
    // response we may not owe costs a glance; staying quiet about one we do owe
    // costs the reply.
    const a = act({ traction: "replied", leadName: "Samuel Diaz", replyThread: null }, NOW);
    expect(a.text).toBe("Samuel replied, write back");
  });

  it("still speaks without a lead name or a usable date", () => {
    expect(act({ traction: "replied", replyThread: { awaitingOurReply: false, lastMessageAt: null } }, NOW).text).toBe(
      "You had an email thread",
    );
    expect(act({ traction: "replied", replyThread: answered }, NOW).text).toBe("You had an email thread (2 days ago)");
  });
});

/**
 * "Follow up if it's been a while" handed the reader the judgment and none of
 * the evidence (CAR-253). The date was already in hand.
 */
describe("deriveNextAction — how long you have been waiting (CAR-253)", () => {
  it("says how long ago you reached out", () => {
    const a = act({ traction: "contacted", leadName: "Julian Ross", lastOutreachAt: "2026-07-08T10:00:00Z" }, NOW);
    expect(a.text).toBe("Waiting on Julian. You reached out 3 days ago");
  });

  it("names today and yesterday rather than counting them", () => {
    expect(act({ traction: "contacted", leadName: "Julian Ross", lastOutreachAt: "2026-07-11T09:00:00Z" }, NOW).text).toBe(
      "Waiting on Julian. You reached out today",
    );
    expect(act({ traction: "contacted", leadName: "Julian Ross", lastOutreachAt: "2026-07-10T09:00:00Z" }, NOW).text).toBe(
      "Waiting on Julian. You reached out yesterday",
    );
  });

  it("dates the no-lead variant too", () => {
    expect(act({ traction: "contacted", lastOutreachAt: "2026-07-08T10:00:00Z" }, NOW).text).toBe(
      "No reply yet. You reached out 3 days ago",
    );
  });

  it("keeps the old copy when the touch carries no usable date", () => {
    // An interaction logged without a date, or an email whose Date: header did
    // not parse. Better vague than wrong.
    expect(act({ traction: "contacted", leadName: "Julian Ross" }, NOW).text).toBe(
      "Waiting on Julian. Follow up if it's been a while",
    );
    expect(act({ traction: "contacted" }, NOW).text).toBe("No reply yet. Follow up");
  });

  it("drops the clause rather than claiming you reached out in the future", () => {
    const a = act({ traction: "contacted", leadName: "Julian Ross", lastOutreachAt: "2026-07-20T10:00:00Z" }, NOW);
    expect(a.text).toBe("Waiting on Julian. Follow up if it's been a while");
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
      lead_detail: { last_outreach_at: null, reply: { awaitingOurReply: true, lastMessageAt: "2026-07-18T00:00:00Z" } },
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
