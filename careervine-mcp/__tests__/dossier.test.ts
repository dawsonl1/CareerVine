import { describe, it, expect } from "vitest";
import { buildDossier, daysSince, isByuLikeSchool } from "../lib/dossier.ts";
import type { DossierBundle } from "../lib/db.ts";

const NOW = new Date("2026-07-08T12:00:00Z");

function fixtureBundle(overrides: Partial<DossierBundle> = {}): DossierBundle {
  return {
    contact: {
      id: 42,
      name: "Jane Doe",
      headline: "PM @ Acme",
      industry: "Tech",
      persona: "product_peer",
      linkedin_url: "https://linkedin.com/in/janedoe",
      notes: "Met at conference",
      met_through: "Tim",
      network_status: "prospect",
      stage_override: null,
      review_note: null,
      follow_up_frequency_days: 30,
      contact_status: null,
      expected_graduation: null,
      created_at: "2026-06-01T00:00:00Z",
      locations: { city: "Provo", state: "UT", country: "United States" },
      contact_emails: [
        { email: "jane@acme.com", is_primary: true, source: "verified", bounced_at: null },
        { email: "old@dead.com", is_primary: false, source: "pattern_guessed", bounced_at: "2026-05-01" },
      ],
      contact_phones: [{ phone: "555-1234", type: "mobile", is_primary: true }],
      contact_companies: [
        {
          title: "Product Manager",
          is_current: true,
          start_month: "Jan 2024",
          end_month: null,
          workplace_type: "hybrid",
          companies: { id: 7, name: "Acme" },
        },
        {
          title: "APM",
          is_current: false,
          start_month: "Jun 2022",
          end_month: "Dec 2023",
          workplace_type: null,
          companies: { id: 8, name: "OldCo" },
        },
      ],
      contact_schools: [
        {
          degree: "BS",
          field_of_study: "Information Systems",
          start_year: 2018,
          end_year: 2022,
          schools: { name: "Brigham Young University" },
        },
      ],
      contact_tags: [{ tags: { name: "apm-programs" } }],
    },
    interactions: [
      { id: 1, interaction_date: "2026-07-01T10:00:00Z", interaction_type: "email", summary: "Sent intro" },
    ],
    interactionsTotal: 14,
    meetings: [
      { id: 1, meeting_date: "2026-06-20T00:00:00Z", meeting_type: "coffee", title: "Chat", notes: "x" },
    ],
    meetingsTotal: 3,
    emails: [
      { gmail_message_id: "m1", thread_id: "t1", subject: "Intro", snippet: "Hi", date: "2026-07-01", direction: "outbound" },
    ],
    emailsTotal: 3,
    openActionItems: [{ id: 9, title: "Send follow-up", is_completed: false }],
    completedActionItems: [],
    scheduledEmails: [],
    activeFollowUps: [],
    ...overrides,
  };
}

describe("buildDossier", () => {
  it("assembles identity, status, and provenance-flagged emails", () => {
    const d = buildDossier(fixtureBundle(), "contacted", NOW);

    expect(d.identity).toMatchObject({
      contact_id: 42,
      name: "Jane Doe",
      location: "Provo, UT, United States",
      is_byu_alum: true,
    });
    expect(d.status).toMatchObject({
      network_tier: "prospect",
      outreach_stage: "contacted",
      follow_up_cadence_days: 30,
      last_touch: "2026-07-01T10:00:00Z",
      last_touch_days_ago: 7,
    });
    expect(d.emails).toEqual([
      { email: "jane@acme.com", is_primary: true, source: "verified", bounced: false },
      { email: "old@dead.com", is_primary: false, source: "pattern_guessed", bounced: true },
    ]);
    expect(d.tags).toEqual(["apm-programs"]);
  });

  it("orders work history current-first", () => {
    const d = buildDossier(fixtureBundle(), null, NOW);
    expect(d.work_history[0]).toMatchObject({ company: "Acme", is_current: true });
    expect(d.work_history[1]).toMatchObject({ company: "OldCo", is_current: false });
  });

  it("reports shown vs total counts so recent depth is honest about truncation", () => {
    const d = buildDossier(fixtureBundle(), null, NOW);
    expect(d.interactions.total).toBe(14);
    expect(d.interactions.shown).toHaveLength(1);
    expect(d.email_history.total).toBe(3);
    expect(d.email_history.shown).toHaveLength(1);
    // Meetings must report a total like interactions/emails (not a bare array).
    expect(d.meetings.total).toBe(3);
    expect(d.meetings.shown).toHaveLength(1);
  });

  it("summarizes tier, stage, last touch, alum flag, and open items in one line", () => {
    const d = buildDossier(fixtureBundle(), "contacted", NOW);
    expect(d.summary).toContain("Jane Doe");
    expect(d.summary).toContain("Product Manager at Acme");
    expect(d.summary).toContain("prospect");
    expect(d.summary).toContain("contacted");
    expect(d.summary).toContain("7 days ago");
    expect(d.summary).toContain("BYU alum");
    expect(d.summary).toContain("1 open action item");
  });

  it("says never-contacted when there are no touches", () => {
    const d = buildDossier(
      fixtureBundle({ interactions: [], interactionsTotal: 0, meetings: [] }),
      "not_contacted",
      NOW,
    );
    expect(d.summary).toContain("Never contacted");
    expect(d.status.last_touch).toBeNull();
  });
});

describe("helpers", () => {
  it("daysSince handles null and bad input", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("not-a-date", NOW)).toBeNull();
    expect(daysSince("2026-07-01T12:00:00Z", NOW)).toBe(7);
  });

  it("isByuLikeSchool matches BYU variants only", () => {
    expect(isByuLikeSchool("Brigham Young University")).toBe(true);
    expect(isByuLikeSchool("BYU Marriott School of Business")).toBe(true);
    expect(isByuLikeSchool("University of Utah")).toBe(false);
  });
});
