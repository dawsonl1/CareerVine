import { describe, it, expect } from "vitest";
import {
  generateGraduationSuggestions,
  generateNoInteractionCadenceSuggestions,
  generateDecayWarningSuggestions,
} from "@/lib/ai-followup/generate-suggestions";
import { SuggestionReasonType } from "@/lib/constants";
import type { SuggestionContact } from "@/lib/ai-followup/suggestion-types";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<SuggestionContact> = {}): SuggestionContact {
  return {
    id: 1,
    name: "Test Contact",
    photo_url: null,
    industry: "Tech",
    contact_status: null,
    expected_graduation: null,
    follow_up_frequency_days: null,
    notes: null,
    last_touch: null,
    days_since_touch: null,
    interaction_count: 0,
    ...overrides,
  };
}

// ── Graduation Suggestions ───────────────────────────────────────────────

describe("generateGraduationSuggestions", () => {
  const today = new Date("2026-03-20");

  it("suggests for student graduating within 30 days", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-04-10",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(1);
    expect(result[0].reasonType).toBe(SuggestionReasonType.Graduation);
    expect(result[0].headline).toContain("coming up soon");
    expect(result[0].score).toBeGreaterThanOrEqual(70);
    expect(result[0].score).toBeLessThanOrEqual(90);
  });

  it("suggests for student graduating within 60 days", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-05-15",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(1);
    expect(result[0].headline).toContain("weeks");
  });

  it("suggests for student graduating within 90 days", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-06-15",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(1);
  });

  it("suggests for student who recently graduated (within 30 days past)", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-03-05",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(1);
    expect(result[0].headline).toContain("graduated recently");
  });

  it("skips student with graduation > 90 days away", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-07-01",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });

  it("skips student with graduation > 30 days in the past", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "2026-02-01",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });

  it("skips null expected_graduation", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: null,
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });

  it("skips unparseable graduation date", () => {
    const contacts = [makeContact({
      contact_status: "student",
      expected_graduation: "not-a-date",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });

  it("skips professional contacts even with graduation date", () => {
    const contacts = [makeContact({
      contact_status: "professional",
      expected_graduation: "2026-04-10",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });

  it("skips contacts with null contact_status", () => {
    const contacts = [makeContact({
      contact_status: null,
      expected_graduation: "2026-04-10",
    })];
    const result = generateGraduationSuggestions(contacts, today);
    expect(result).toHaveLength(0);
  });
});

// ── No-Interaction Cadence Suggestions ──────────────────────────────────

describe("generateNoInteractionCadenceSuggestions", () => {
  it("suggests for zero-interaction contact with overdue cadence", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: 14,
      interaction_count: 0,
      days_since_touch: 20,
      last_touch: "2026-03-01",
    })];
    const result = generateNoInteractionCadenceSuggestions(contacts);
    expect(result).toHaveLength(1);
    expect(result[0].reasonType).toBe(SuggestionReasonType.NoInteractionCadence);
    expect(result[0].score).toBe(75);
  });

  it("skips contact with interactions", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: 14,
      interaction_count: 1,
      days_since_touch: 20,
    })];
    const result = generateNoInteractionCadenceSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("skips contact without cadence", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: null,
      interaction_count: 0,
      days_since_touch: 20,
    })];
    const result = generateNoInteractionCadenceSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("skips contact not yet overdue", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: 30,
      interaction_count: 0,
      days_since_touch: 20,
    })];
    const result = generateNoInteractionCadenceSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("skips contact with null days_since_touch", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: 14,
      interaction_count: 0,
      days_since_touch: null,
    })];
    const result = generateNoInteractionCadenceSuggestions(contacts);
    expect(result).toHaveLength(0);
  });
});

// ── Decay Warning Suggestions ───────────────────────────────────────────

describe("generateDecayWarningSuggestions", () => {
  it("suggests for contact with >60 days silence and >=2 interactions", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: null,
      interaction_count: 3,
      days_since_touch: 75,
    })];
    const result = generateDecayWarningSuggestions(contacts);
    expect(result).toHaveLength(1);
    expect(result[0].reasonType).toBe(SuggestionReasonType.DecayWarning);
    expect(result[0].score).toBeGreaterThanOrEqual(65);
    expect(result[0].score).toBeLessThanOrEqual(85);
  });

  it("score increases with more days of silence", () => {
    const contact90 = makeContact({ interaction_count: 2, days_since_touch: 90 });
    const contact120 = makeContact({ id: 2, interaction_count: 2, days_since_touch: 120 });
    const r90 = generateDecayWarningSuggestions([contact90]);
    const r120 = generateDecayWarningSuggestions([contact120]);
    expect(r120[0].score).toBeGreaterThan(r90[0].score);
  });

  it("skips contact with cadence set", () => {
    const contacts = [makeContact({
      follow_up_frequency_days: 30,
      interaction_count: 3,
      days_since_touch: 75,
    })];
    const result = generateDecayWarningSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("skips contact with fewer than 2 interactions", () => {
    const contacts = [makeContact({
      interaction_count: 1,
      days_since_touch: 75,
    })];
    const result = generateDecayWarningSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("skips contact at exactly 60 days (threshold is >60)", () => {
    const contacts = [makeContact({
      interaction_count: 2,
      days_since_touch: 60,
    })];
    const result = generateDecayWarningSuggestions(contacts);
    expect(result).toHaveLength(0);
  });

  it("suggests at 61 days", () => {
    const contacts = [makeContact({
      interaction_count: 2,
      days_since_touch: 61,
    })];
    const result = generateDecayWarningSuggestions(contacts);
    expect(result).toHaveLength(1);
  });
});
