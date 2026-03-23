# First-Touch Suggestions for New Contacts

**Finding:** When a new contact is added with no prior communication, the AI suggestions don't account for this being a first touch. The existing `NoInteractionCadence` rule only fires if a cadence is set, and the LLM generator skips contacts with zero interactions. Most new contacts get no suggestions at all.

## Problem

| Generator | Handles zero-interaction contacts? |
|-----------|-----------------------------------|
| Graduation | Only if student with graduation date |
| NoInteractionCadence | Only if cadence is set |
| DecayWarning | No (requires 2+ interactions) |
| LLM | No (requires interactions or notes) |

## Solution

Add a new rule-based generator: `generateFirstTouchSuggestions`

**Trigger conditions:**
- `interaction_count === 0` (never contacted)
- `follow_up_frequency_days === null` (no cadence — if they have a cadence, NoInteractionCadence already handles them)
- Contact was added within the last 30 days (don't nag about old contacts)

**Suggested actions — contextual based on available data:**
- Has email → "Send an intro email to {name}"
- Has LinkedIn → "Connect with {name} on LinkedIn"
- Met through someone → "Send a warm intro referencing {met_through}"
- Has industry/notes → "Reach out to {name} about {industry/context}"
- Default → "Introduce yourself to {name}"

**Headlines:**
- "You haven't reached out to {name} yet"
- "New contact — time to break the ice with {name}"

**Score:** 72 (just below NoInteractionCadence at 75)
**Reason type:** New constant `FirstTouch`

## Files to modify

- `src/lib/ai-followup/generate-suggestions.ts` — add generator, wire into orchestrator
- `src/lib/ai-followup/suggestion-types.ts` — add email/linkedin fields to SuggestionContact if needed
- `src/lib/constants.ts` — add `FirstTouch` to SuggestionReasonType
- `src/__tests__/suggestion-generators.test.ts` — add tests
- Data query may need to join contact_emails to check if email exists
