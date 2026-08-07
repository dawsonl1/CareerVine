/**
 * CAR-242 — the shared conversation vocabulary.
 *
 * These lock the two invariants the DB CHECKs enforce on the other side of the
 * wire (`meetings_meeting_type_check` and its `_detail_` sibling, added in
 * 20260807040000_car242_narrow_conversation_types.sql). The integration guard
 * check-constraints.itest.ts proves the CHECKs exist and match; this proves the
 * app never tries to write outside them in the first place.
 */
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TYPE_DETAIL_MAX_LENGTH,
  CONVERSATION_TYPE_OPTIONS,
  CONVERSATION_TYPE_VALUES,
  ConversationType,
  INTERACTION_TYPE_VALUES,
  SYSTEM_INTERACTION_TYPE_EMAIL,
  conversationTypeLabel,
  normalizeConversationTypeDetail,
} from "@/lib/constants";

describe("the vocabulary itself", () => {
  it("is exactly the five user-selectable types, in picker order", () => {
    expect(CONVERSATION_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      "career-fair",
      "networking",
      "coffee",
      "text",
      "other",
    ]);
  });

  it("keeps the option list and the CHECK vocabulary in lockstep", () => {
    expect(CONVERSATION_TYPE_OPTIONS.map((o) => o.value)).toEqual([...CONVERSATION_TYPE_VALUES]);
  });

  it("adds email to the interaction vocabulary but never to the picker", () => {
    expect(INTERACTION_TYPE_VALUES).toContain(SYSTEM_INTERACTION_TYPE_EMAIL);
    expect(CONVERSATION_TYPE_OPTIONS.map((o) => o.value)).not.toContain(SYSTEM_INTERACTION_TYPE_EMAIL);
  });

  it("gives every option a distinct icon name, so no chip renders bare", () => {
    const icons = CONVERSATION_TYPE_OPTIONS.map((o) => o.iconName);
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons.every(Boolean)).toBe(true);
  });

  it("no longer offers the retired types the backfill folded away", () => {
    const values = CONVERSATION_TYPE_OPTIONS.map((o) => o.value);
    for (const retired of ["phone", "video", "in-person", "lunch", "conference", "social", "call", "event", "meeting"]) {
      expect(values).not.toContain(retired);
    }
  });
});

describe("normalizeConversationTypeDetail", () => {
  it("keeps trimmed free text under Other", () => {
    expect(normalizeConversationTypeDetail(ConversationType.Other, "  Alumni panel  ")).toBe("Alumni panel");
  });

  it("drops the detail for every non-Other type — the CHECK rejects it otherwise", () => {
    for (const type of CONVERSATION_TYPE_VALUES.filter((v) => v !== ConversationType.Other)) {
      expect(normalizeConversationTypeDetail(type, "Alumni panel")).toBeNull();
    }
  });

  it("collapses blank and whitespace-only detail to null", () => {
    expect(normalizeConversationTypeDetail(ConversationType.Other, "")).toBeNull();
    expect(normalizeConversationTypeDetail(ConversationType.Other, "   ")).toBeNull();
    expect(normalizeConversationTypeDetail(ConversationType.Other, undefined)).toBeNull();
  });

  it("truncates to the length the CHECK allows rather than letting the write 23514", () => {
    const long = "x".repeat(200);
    const out = normalizeConversationTypeDetail(ConversationType.Other, long);
    expect(out).toHaveLength(CONVERSATION_TYPE_DETAIL_MAX_LENGTH);
  });

  it("drops a detail left over from a type the user switched away from", () => {
    // The exact regression the CHECK guards: pick Other, type something, then
    // pick Coffee Chat. The stale string must not reach the DB.
    expect(normalizeConversationTypeDetail(ConversationType.Coffee, "Alumni panel")).toBeNull();
  });
});

describe("conversationTypeLabel", () => {
  it("renders each type's human label", () => {
    expect(conversationTypeLabel(ConversationType.CareerFair)).toBe("Career Fair");
    expect(conversationTypeLabel(ConversationType.Networking)).toBe("Networking Event");
    expect(conversationTypeLabel(ConversationType.Coffee)).toBe("Coffee Chat");
    expect(conversationTypeLabel(ConversationType.Text)).toBe("Text Message Chat");
  });

  it("prefers the user's own words for Other", () => {
    expect(conversationTypeLabel(ConversationType.Other, "Alumni panel")).toBe("Alumni panel");
  });

  it("falls back to 'Other' when the detail is absent or blank", () => {
    expect(conversationTypeLabel(ConversationType.Other, null)).toBe("Other");
    expect(conversationTypeLabel(ConversationType.Other, "   ")).toBe("Other");
  });

  it("names the system email type", () => {
    expect(conversationTypeLabel(SYSTEM_INTERACTION_TYPE_EMAIL)).toBe("Email");
  });

  it("returns null for an absent type so callers keep their own fallback", () => {
    expect(conversationTypeLabel(null)).toBeNull();
    expect(conversationTypeLabel("")).toBeNull();
  });

  it("humanizes a pre-backfill value instead of leaking the raw slug", () => {
    // CSS `capitalize` (what these call sites used before) rendered this as
    // "In-person"; the helper is why hyphenated values read correctly.
    expect(conversationTypeLabel("in-person")).toBe("In person");
  });
});
