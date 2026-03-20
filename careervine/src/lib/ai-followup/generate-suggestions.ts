/**
 * Smart follow-up suggestion engine.
 *
 * Generates 3-5 ephemeral suggestions per session using:
 * 1. Rule-based generators (fast, no LLM)
 * 2. LLM batch generator (single call for remaining slots)
 *
 * Suggestions are never persisted — saving one creates an action item.
 */

import OpenAI from "openai";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { gatherContactContext, formatContextForLLM } from "./gather-context";
import { SuggestionReasonType, ActionItemSource } from "@/lib/constants";
import type { Suggestion, SuggestionContact } from "./suggestion-types";

const MAX_SUGGESTIONS = 5;
const MAX_LLM_CONTACTS = 5;
const CACHE_TTL_MS = 60_000; // 60s cache to avoid duplicate work across pages

// ── In-memory cache ────────────────────────────────────────────────────

const suggestionCache = new Map<string, { suggestions: Suggestion[]; expiresAt: number }>();

/** Invalidate cached suggestions for a user (e.g. after saving one). */
export function invalidateSuggestionCache(userId: string) {
  suggestionCache.delete(userId);
}

// ── Data Fetching ──────────────────────────────────────────────────────

export async function fetchSuggestionCandidates(userId: string): Promise<SuggestionContact[]> {
  const service = createSupabaseServiceClient();

  // Fetch contacts and last-touch data in parallel (independent queries)
  const [contactsResult, touchResult] = await Promise.all([
    service
      .from("contacts")
      .select("id, name, photo_url, industry, contact_status, expected_graduation, follow_up_frequency_days, notes")
      .eq("user_id", userId),
    service.rpc("get_contacts_with_last_touch", { p_user_id: userId }),
  ]);

  const contacts = contactsResult.data;
  if (contactsResult.error || !contacts) return [];

  const touchMap = new Map<number, { last_touch: string | null; days_since_touch: number | null }>();
  for (const t of touchResult.data || []) {
    touchMap.set(t.id, { last_touch: t.last_touch, days_since_touch: t.days_since_touch });
  }

  // Fetch interaction counts (select only contact_id, count client-side)
  const contactIds = contacts.map((c) => c.id);
  const { data: interactionRows } = await service
    .from("interactions")
    .select("contact_id")
    .in("contact_id", contactIds);

  const countMap = new Map<number, number>();
  for (const row of interactionRows || []) {
    countMap.set(row.contact_id, (countMap.get(row.contact_id) || 0) + 1);
  }

  return contacts.map((c) => {
    const touch = touchMap.get(c.id);
    return {
      ...c,
      last_touch: touch?.last_touch ?? null,
      days_since_touch: touch?.days_since_touch ?? null,
      interaction_count: countMap.get(c.id) || 0,
    };
  });
}

// ── Rule-Based Generators ──────────────────────────────────────────────

export function generateGraduationSuggestions(
  contacts: SuggestionContact[],
  today: Date = new Date(),
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const c of contacts) {
    if (c.contact_status !== "student" || !c.expected_graduation) continue;

    const gradDate = new Date(c.expected_graduation);
    if (isNaN(gradDate.getTime())) continue;

    const daysUntilGrad = Math.floor(
      (gradDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Within 90 days before or 30 days after graduation
    if (daysUntilGrad > 90 || daysUntilGrad < -30) continue;

    const isPast = daysUntilGrad <= 0;
    const headline = isPast
      ? `${c.name} likely graduated recently`
      : daysUntilGrad <= 30
        ? `${c.name}'s graduation is coming up soon`
        : `${c.name}'s graduation is in about ${Math.round(daysUntilGrad / 7)} weeks`;

    const evidence = isPast
      ? `Expected graduation: ${gradDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`
      : `Graduating ${gradDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;

    // Score: closer to graduation = higher score
    const proximityBonus = isPast ? 20 : Math.max(0, 20 - Math.floor(daysUntilGrad / 5));
    const score = 70 + proximityBonus;

    suggestions.push({
      id: `grad-${c.id}`,
      contactId: c.id,
      contactName: c.name,
      contactPhotoUrl: c.photo_url,
      contactIndustry: c.industry,
      headline,
      evidence,
      reasonType: SuggestionReasonType.Graduation,
      score: Math.min(90, score),
      suggestedTitle: isPast
        ? `Congratulate ${c.name} on graduating`
        : `Reach out to ${c.name} about upcoming graduation`,
      suggestedDescription: isPast
        ? "Congratulate them and ask about their next steps or job search."
        : "Check in about their plans after graduation — job search, grad school, etc.",
      daysSinceContact: c.days_since_touch,
    });
  }

  return suggestions;
}

export function generateNoInteractionCadenceSuggestions(
  contacts: SuggestionContact[],
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const c of contacts) {
    // Must have a cadence set, zero interactions, and be overdue
    if (!c.follow_up_frequency_days || c.interaction_count > 0) continue;
    if (c.days_since_touch === null) continue;
    if (c.days_since_touch < c.follow_up_frequency_days) continue;

    const daysOverdue = c.days_since_touch - c.follow_up_frequency_days;

    suggestions.push({
      id: `nointeract-${c.id}`,
      contactId: c.id,
      contactName: c.name,
      contactPhotoUrl: c.photo_url,
      contactIndustry: c.industry,
      headline: `You added ${c.name} but haven't had a conversation yet`,
      evidence: `Added ${c.days_since_touch} days ago · Follow-up cadence is every ${c.follow_up_frequency_days} days`,
      reasonType: SuggestionReasonType.NoInteractionCadence,
      score: 75,
      suggestedTitle: `Have your first conversation with ${c.name}`,
      suggestedDescription: `You set a ${c.follow_up_frequency_days}-day follow-up cadence but haven't logged an interaction yet. Reach out to start the relationship.`,
      daysSinceContact: c.days_since_touch,
    });
  }

  return suggestions;
}

export function generateDecayWarningSuggestions(
  contacts: SuggestionContact[],
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const c of contacts) {
    // No cadence set, >60 days since contact, has >=2 past interactions
    if (c.follow_up_frequency_days) continue;
    if (c.interaction_count < 2) continue;
    if (c.days_since_touch === null || c.days_since_touch <= 60) continue;

    // Score: more days = higher urgency
    const score = Math.min(85, 65 + Math.floor((c.days_since_touch - 60) / 10));

    suggestions.push({
      id: `decay-${c.id}`,
      contactId: c.id,
      contactName: c.name,
      contactPhotoUrl: c.photo_url,
      contactIndustry: c.industry,
      headline: `It's been ${c.days_since_touch} days since you talked to ${c.name}`,
      evidence: `${c.interaction_count} past interactions · No follow-up cadence set`,
      reasonType: SuggestionReasonType.DecayWarning,
      score,
      suggestedTitle: `Reconnect with ${c.name}`,
      suggestedDescription: `You've had ${c.interaction_count} conversations but it's been ${c.days_since_touch} days since the last one. Consider setting a follow-up cadence.`,
      daysSinceContact: c.days_since_touch,
    });
  }

  return suggestions;
}

// ── LLM Batch Generator ───────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You analyze a user's professional network contacts and their interaction history to suggest who they should reach out to and why.

For each contact provided, determine the single best reason to reach out RIGHT NOW:
1. Is there a forward-looking topic from past conversations whose follow-up window has arrived? (e.g., they mentioned starting a new job, launching a product, interviewing somewhere)
2. If not, what was the most interesting or personal topic from the last conversation that could anchor a natural follow-up?
3. If there's no conversation history, say so — don't fabricate a reason.

Rules:
- Be SPECIFIC — reference actual topics, dates, and details from the conversations
- Suggest a concrete action ("ask how the launch went") not a vague reminder ("follow up")
- If there's genuinely nothing to go on, return null for that contact
- Headlines: under 80 characters, conversational tone
- Suggested actions: under 100 characters, starts with a verb`;

const LLM_RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "follow_up_suggestions",
    strict: true,
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contactId: { type: "number" },
              headline: { type: ["string", "null"] },
              detail: { type: ["string", "null"] },
              suggestedAction: { type: ["string", "null"] },
              evidence: { type: ["string", "null"] },
              confidence: { type: "number" },
            },
            required: ["contactId", "headline", "detail", "suggestedAction", "evidence", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  },
};

export async function generateLlmSuggestions(
  userId: string,
  contacts: SuggestionContact[],
  coveredContactIds: Set<number>,
): Promise<Suggestion[]> {
  // Pick uncovered contacts with rich data potential (have interactions or notes)
  const candidates = contacts
    .filter((c) => !coveredContactIds.has(c.id) && (c.interaction_count > 0 || c.notes))
    .sort((a, b) => (b.days_since_touch ?? 0) - (a.days_since_touch ?? 0))
    .slice(0, MAX_LLM_CONTACTS);

  if (candidates.length === 0) return [];

  // Gather context for each candidate in parallel
  const contextEntries = await Promise.all(
    candidates.map(async (c) => {
      try {
        const ctx = await gatherContactContext(userId, c.id);
        return { contact: c, context: formatContextForLLM(ctx) };
      } catch {
        return null;
      }
    }),
  );

  const validEntries = contextEntries.filter(Boolean) as { contact: SuggestionContact; context: string }[];
  if (validEntries.length === 0) return [];

  // Build batch prompt
  const batchPrompt = validEntries
    .map((e, i) => `--- Contact ${i + 1} (ID: ${e.contact.id}) ---\n${e.context}`)
    .join("\n\n");

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        { role: "user", content: batchPrompt },
      ],
      response_format: LLM_RESPONSE_SCHEMA,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    let parsed: { suggestions: Array<{
      contactId: number;
      headline: string | null;
      detail: string | null;
      suggestedAction: string | null;
      evidence: string | null;
      confidence: number;
    }> };

    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    const contactMap = new Map(validEntries.map((e) => [e.contact.id, e.contact]));

    return parsed.suggestions
      .filter((s) => s.headline && s.confidence > 0.3)
      .map((s) => {
        const contact = contactMap.get(s.contactId);
        if (!contact) return null;

        return {
          id: `llm-${s.contactId}`,
          contactId: s.contactId,
          contactName: contact.name,
          contactPhotoUrl: contact.photo_url,
          contactIndustry: contact.industry,
          headline: s.headline!,
          evidence: s.evidence || s.detail || "",
          reasonType: SuggestionReasonType.LlmPersonalized,
          score: Math.round(s.confidence * 80),
          suggestedTitle: s.suggestedAction
            ? `${s.suggestedAction.charAt(0).toUpperCase()}${s.suggestedAction.slice(1)}`
            : `Follow up with ${contact.name}`,
          suggestedDescription: s.detail || "",
          daysSinceContact: contact.days_since_touch,
        } satisfies Suggestion;
      })
      .filter(Boolean) as Suggestion[];
  } catch (err) {
    console.error("[Suggestion LLM] Error:", err);
    return [];
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────

export async function generateSuggestions(userId: string): Promise<Suggestion[]> {
  // Check cache first to avoid duplicate work across dashboard/action-items navigation
  const cached = suggestionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.suggestions;
  }

  const service = createSupabaseServiceClient();

  // Fetch candidates and existing AI action items in parallel
  const [contacts, existingAiItems] = await Promise.all([
    fetchSuggestionCandidates(userId),
    service
      .from("follow_up_action_items")
      .select("contact_id")
      .eq("user_id", userId)
      .eq("source", ActionItemSource.AiSuggestion)
      .eq("is_completed", false)
      .then(({ data }) => new Set((data || []).map((r) => r.contact_id).filter(Boolean) as number[])),
  ]);

  // Run rule-based generators
  const today = new Date();
  const allRuleBased = [
    ...generateGraduationSuggestions(contacts, today),
    ...generateNoInteractionCadenceSuggestions(contacts),
    ...generateDecayWarningSuggestions(contacts),
  ];

  // Deduplicate: remove contacts that already have pending AI action items
  const dedupedRuleBased = allRuleBased.filter((s) => !existingAiItems.has(s.contactId));

  // Track which contacts are covered by rule-based suggestions
  const coveredContactIds = new Set(dedupedRuleBased.map((s) => s.contactId));
  // Also exclude contacts with existing AI action items from LLM pass
  for (const id of existingAiItems) coveredContactIds.add(id);

  // LLM pass for remaining slots
  let llmSuggestions: Suggestion[] = [];
  if (dedupedRuleBased.length < MAX_SUGGESTIONS) {
    llmSuggestions = await generateLlmSuggestions(userId, contacts, coveredContactIds);
    // Deduplicate LLM results too
    llmSuggestions = llmSuggestions.filter((s) => !existingAiItems.has(s.contactId));
  }

  // Merge, sort by score descending, and return top N
  const all = [...dedupedRuleBased, ...llmSuggestions];
  all.sort((a, b) => b.score - a.score);

  // Deduplicate by contactId (keep highest score)
  const seen = new Set<number>();
  const unique: Suggestion[] = [];
  for (const s of all) {
    if (!seen.has(s.contactId)) {
      seen.add(s.contactId);
      unique.push(s);
    }
  }

  const result = unique.slice(0, MAX_SUGGESTIONS);

  // Cache for 60s to avoid re-running on page navigation
  suggestionCache.set(userId, { suggestions: result, expiresAt: Date.now() + CACHE_TTL_MS });

  return result;
}
