import { describe, it, expect, vi } from "vitest";

/**
 * CAR-143 (R5.4): a malformed article-evaluation response means "skip this
 * article" — it must never throw out of the pipeline.
 */

vi.mock("@/lib/serper", () => ({
  searchNews: vi.fn(async () => [
    {
      title: "Trail running gains",
      url: "https://example.com/article",
      snippet: "s",
      source: "Example",
    },
  ]),
  searchWeb: vi.fn(async () => []),
}));

import { findArticle } from "@/lib/ai-followup/find-article";
import type { ExtractedInterests } from "@/lib/ai-followup/extract-interests";
import type { OpenAIRunner } from "@/lib/openai";

const extracted: ExtractedInterests = {
  interests: [
    { topic: "running", evidence: "e", source: "s", confidence: 0.9, searchQuery: "running" },
  ],
  profileFallbacks: [],
};

function runnerReturning(content: string | null): OpenAIRunner {
  return (async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content } }] }),
        },
      },
    })) as unknown as OpenAIRunner;
}

describe("findArticle eval JSON guard (R5.4)", () => {
  it("returns null (skip) on malformed eval JSON instead of throwing", async () => {
    await expect(findArticle(extracted, runnerReturning('{"verdict": "sen'))).resolves.toBeNull();
  });

  it("returns null on wrong-shaped eval JSON", async () => {
    await expect(findArticle(extracted, runnerReturning('"send"'))).resolves.toBeNull();
  });

  it("still returns the article on a proper send verdict", async () => {
    const result = await findArticle(
      extracted,
      runnerReturning('{"verdict": "send", "reason": "on point"}'),
    );
    expect(result?.article.url).toBe("https://example.com/article");
  });

  it("rethrows AI availability failures instead of burning the eval budget", async () => {
    const { AiUnavailableError } = await import("@/lib/openai");
    const failingRunner = (async () => {
      throw new AiUnavailableError("ai_trial_expired");
    }) as unknown as OpenAIRunner;

    await expect(findArticle(extracted, failingRunner)).rejects.toMatchObject({
      code: "ai_trial_expired",
    });
  });
});
