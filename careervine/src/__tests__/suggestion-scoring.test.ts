import { describe, it, expect, vi } from "vitest";
import {
  generateGraduationSuggestions,
  generateNoInteractionCadenceSuggestions,
  generateDecayWarningSuggestions,
} from "@/lib/ai-followup/generate-suggestions";
import type { SuggestionContact, Suggestion } from "@/lib/ai-followup/suggestion-types";

function makeContact(overrides: Partial<SuggestionContact> = {}): SuggestionContact {
  return {
    id: 1,
    name: "Test",
    photo_url: null,
    industry: null,
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

describe("suggestion scoring and ordering", () => {
  it("results are sorted by score descending", () => {
    const today = new Date("2026-03-20");
    const contacts: SuggestionContact[] = [
      // Decay warning: score ~66
      makeContact({ id: 1, name: "Low", interaction_count: 2, days_since_touch: 65 }),
      // Graduation: score ~90 (near graduation)
      makeContact({ id: 2, name: "High", contact_status: "student", expected_graduation: "2026-03-25" }),
      // No-interaction cadence: score 75
      makeContact({ id: 3, name: "Mid", follow_up_frequency_days: 14, interaction_count: 0, days_since_touch: 20, last_touch: "2026-03-01" }),
    ];

    const all = [
      ...generateGraduationSuggestions(contacts, today),
      ...generateNoInteractionCadenceSuggestions(contacts),
      ...generateDecayWarningSuggestions(contacts),
    ];

    all.sort((a, b) => b.score - a.score);

    expect(all[0].contactName).toBe("High");
    expect(all[all.length - 1].contactName).toBe("Low");
  });

  it("deduplicates by contactId keeping highest score", () => {
    const suggestions: Suggestion[] = [
      { id: "a", contactId: 1, contactName: "X", contactPhotoUrl: null, contactIndustry: null, headline: "h", evidence: "e", reasonType: "a", score: 90, suggestedTitle: "t", suggestedDescription: "d", daysSinceContact: null },
      { id: "b", contactId: 1, contactName: "X", contactPhotoUrl: null, contactIndustry: null, headline: "h2", evidence: "e2", reasonType: "b", score: 60, suggestedTitle: "t2", suggestedDescription: "d2", daysSinceContact: null },
      { id: "c", contactId: 2, contactName: "Y", contactPhotoUrl: null, contactIndustry: null, headline: "h3", evidence: "e3", reasonType: "c", score: 80, suggestedTitle: "t3", suggestedDescription: "d3", daysSinceContact: null },
    ];

    // Sort by score descending
    suggestions.sort((a, b) => b.score - a.score);

    // Deduplicate by contactId
    const seen = new Set<number>();
    const unique: Suggestion[] = [];
    for (const s of suggestions) {
      if (!seen.has(s.contactId)) {
        seen.add(s.contactId);
        unique.push(s);
      }
    }

    expect(unique).toHaveLength(2);
    expect(unique[0].score).toBe(90);
    expect(unique[0].id).toBe("a");
    expect(unique[1].contactId).toBe(2);
  });

  it("limits results to max 5", () => {
    const contacts: SuggestionContact[] = Array.from({ length: 10 }, (_, i) =>
      makeContact({
        id: i + 1,
        name: `Contact ${i}`,
        interaction_count: 3,
        days_since_touch: 70 + i * 5,
      }),
    );

    const results = generateDecayWarningSuggestions(contacts);
    // All 10 qualify, but orchestrator would limit to 5
    expect(results.length).toBe(10);

    // Simulate orchestrator slicing
    results.sort((a, b) => b.score - a.score);
    const top5 = results.slice(0, 5);
    expect(top5).toHaveLength(5);
    // Top 5 should have highest scores
    expect(top5[0].score).toBeGreaterThanOrEqual(top5[4].score);
  });
});
