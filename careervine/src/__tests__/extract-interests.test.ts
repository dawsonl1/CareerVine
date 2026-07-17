import { describe, it, expect } from "vitest";
import { extractInterests } from "@/lib/ai-followup/extract-interests";
import type { ContactContext } from "@/lib/ai-followup/gather-context";
import type { OpenAIRunner } from "@/lib/openai";

/**
 * CAR-143 (R5.4): extractInterests must degrade — never throw — on missing,
 * malformed, or wrong-shaped model JSON (structured outputs are not a
 * guarantee: truncation and provider downgrades produce off-schema content).
 */

const ctx: ContactContext = {
  contactName: "Sam Doe",
  role: null,
  industry: "Tech",
  companies: [],
  schools: [],
  location: null,
  notes: "loves hiking",
  metThrough: null,
  contactStatus: null,
  expectedGraduation: null,
  meetings: [],
  interactions: [],
  hasRichData: true,
};

function runnerReturning(content: string | null): OpenAIRunner {
  return (async () => ({
    choices: [{ message: { content } }],
  })) as unknown as OpenAIRunner;
}

const EMPTY = { interests: [], profileFallbacks: [] };

describe("extractInterests JSON guards (R5.4)", () => {
  it("degrades to empty on missing content", async () => {
    expect(await extractInterests(ctx, runnerReturning(null))).toEqual(EMPTY);
  });

  it("degrades to empty on malformed JSON", async () => {
    expect(await extractInterests(ctx, runnerReturning('{"interests": [tru'))).toEqual(EMPTY);
  });

  it("degrades to empty on valid JSON with the wrong shape — never throws", async () => {
    // .sort on these would previously have thrown TypeError.
    expect(
      await extractInterests(ctx, runnerReturning('{"interests": "gardening"}')),
    ).toEqual(EMPTY);
    expect(await extractInterests(ctx, runnerReturning('"just a string"'))).toEqual(EMPTY);
    expect(await extractInterests(ctx, runnerReturning("42"))).toEqual(EMPTY);
    expect(await extractInterests(ctx, runnerReturning("null"))).toEqual(EMPTY);
    expect(
      await extractInterests(ctx, runnerReturning('{"interests": {"topic": "x"}}')),
    ).toEqual(EMPTY);
  });

  it("keeps a well-formed half when the other half is malformed", async () => {
    const result = await extractInterests(
      ctx,
      runnerReturning(
        JSON.stringify({
          interests: [
            { topic: "a", evidence: "e", source: "s", confidence: 0.2, searchQuery: "q" },
          ],
          profileFallbacks: "nope",
        }),
      ),
    );
    expect(result.interests).toHaveLength(1);
    expect(result.profileFallbacks).toEqual([]);
  });

  it("sorts by confidence and tolerates non-numeric confidence values", async () => {
    const result = await extractInterests(
      ctx,
      runnerReturning(
        JSON.stringify({
          interests: [
            { topic: "low", evidence: "e", source: "s", confidence: 0.1, searchQuery: "q" },
            { topic: "junk", evidence: "e", source: "s", confidence: "high", searchQuery: "q" },
            { topic: "top", evidence: "e", source: "s", confidence: 0.9, searchQuery: "q" },
          ],
          profileFallbacks: [],
        }),
      ),
    );
    expect(result.interests.map((i) => i.topic)).toEqual(["top", "low", "junk"]);
  });
});
