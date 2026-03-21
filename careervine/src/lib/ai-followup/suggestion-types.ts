/**
 * Ephemeral suggestion types — not persisted to DB.
 * Used for in-memory suggestion generation and display.
 */

export interface Suggestion {
  id: string;                // Unique ID for React keys (e.g. "grad-42")
  contactId: number;
  contactName: string;
  contactPhotoUrl: string | null;
  contactIndustry: string | null;
  headline: string;          // Contextual "why" — displayed prominently
  evidence: string;          // Quote or data point backing the suggestion
  reasonType: string;        // Maps to SuggestionReasonType values
  score: number;             // 0-100, used for ranking
  suggestedTitle: string;    // Pre-filled action item title if saved
  suggestedDescription: string; // Pre-filled action item description if saved
  daysSinceContact: number | null; // Days since last interaction
}

export interface SuggestionContact {
  id: number;
  name: string;
  photo_url: string | null;
  industry: string | null;
  contact_status: string | null;
  expected_graduation: string | null;
  follow_up_frequency_days: number | null;
  notes: string | null;
  met_through: string | null;
  last_touch: string | null;
  days_since_touch: number | null;
  interaction_count: number;
}
