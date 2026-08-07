import { describe, it, expect } from "vitest";
import { stageChipLabels } from "@/lib/stage-derivation";

/**
 * Per-kind chips on a single contact (CAR-267).
 *
 * Production symptom: Spencer Hintze's card on the Lucid Software page showed a
 * "Call done" chip off one meeting typed `text` ("LinkedIn chat") — the same
 * misrepresentation CAR-257 fixed on the next-action pill, one surface over.
 * The chip row now names each distinct conversation kind individually and only
 * says "Call done" when a call actually happened.
 */
describe("stageChipLabels (CAR-267)", () => {
  it("names a text exchange Texted, never Call done", () => {
    expect(stageChipLabels("call_done", { past: { kinds: ["text"] }, upcoming: null })).toEqual([
      "Texted",
    ]);
  });

  it("gives every past kind its own chip, preserving the caller's recency order", () => {
    expect(
      stageChipLabels("call_done", {
        past: { kinds: ["text", "call", "career-fair", "networking", "other"] },
        upcoming: null,
      }),
    ).toEqual(["Texted", "Call done", "Career fair", "Networking event", "Conversation"]);
  });

  it("keeps Call done for a real call", () => {
    expect(stageChipLabels("call_done", { past: { kinds: ["call"] }, upcoming: null })).toEqual([
      "Call done",
    ]);
  });

  it("falls back to the stage label when no conversation backs the stage (stage_override)", () => {
    // The override literally asserts "call done" with no event to describe, so
    // the stage label is exactly its claim.
    expect(stageChipLabels("call_done", { past: null, upcoming: null })).toEqual(["Call done"]);
    expect(stageChipLabels("call_done", null)).toEqual(["Call done"]);
    expect(stageChipLabels("call_done")).toEqual(["Call done"]);
    expect(stageChipLabels("call_done", { past: { kinds: [] }, upcoming: null })).toEqual([
      "Call done",
    ]);
  });

  it("words upcoming conversations as scheduled, per kind", () => {
    expect(
      stageChipLabels("call_scheduled", {
        past: null,
        upcoming: { kinds: ["career-fair", "call"] },
      }),
    ).toEqual(["Career fair scheduled", "Call scheduled"]);
  });

  it("collapses scheduled text and other to one neutral chip", () => {
    // You do not schedule a text exchange (CAR-257's reasoning on the pill):
    // both mislabels share the one wording that cannot be wrong, deduped.
    expect(
      stageChipLabels("call_scheduled", { past: null, upcoming: { kinds: ["text", "other"] } }),
    ).toEqual(["Conversation scheduled"]);
  });

  it("reads the correct side for each call stage", () => {
    // call_done must not read upcoming kinds, nor call_scheduled past ones.
    expect(
      stageChipLabels("call_done", { past: null, upcoming: { kinds: ["career-fair"] } }),
    ).toEqual(["Call done"]);
    expect(
      stageChipLabels("call_scheduled", { past: { kinds: ["career-fair"] }, upcoming: null }),
    ).toEqual(["Call scheduled"]);
  });

  it("leaves every non-call stage at its plain label, whatever the history holds", () => {
    expect(
      stageChipLabels("replied", { past: { kinds: ["text"] }, upcoming: { kinds: ["call"] } }),
    ).toEqual(["Replied"]);
    expect(stageChipLabels("not_contacted")).toEqual(["Not contacted"]);
    expect(stageChipLabels("contacted")).toEqual(["Contacted"]);
    expect(stageChipLabels("bounced")).toEqual(["Bounced"]);
    expect(stageChipLabels("referral")).toEqual(["Referral"]);
  });
});
