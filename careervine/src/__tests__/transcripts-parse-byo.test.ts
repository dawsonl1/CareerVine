import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-123", email: "test@example.com" } },
        error: null,
      }),
    },
  }),
}));

const mockRunWithOpenAIFallback = vi.fn();

vi.mock("@/lib/openai", () => ({
  runWithOpenAIFallback: (...args: unknown[]) => mockRunWithOpenAIFallback(...args),
  DEFAULT_MODEL: "gpt-5-mini",
}));

import { POST } from "@/app/api/transcripts/parse/route";

function makeRequest(body: unknown) {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/transcripts/parse"),
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

describe("transcripts/parse BYO fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWithOpenAIFallback.mockImplementation(async (_userId, fn) => {
      const client = {
        responses: {
          create: vi.fn().mockResolvedValue({
            output_text: JSON.stringify({
              segments: [{ speaker_label: "Alice", content: "Hello" }],
            }),
          }),
        },
      };
      return fn(client);
    });
  });

  it("routes OpenAI calls through runWithOpenAIFallback", async () => {
    const response = await POST(
      makeRequest({ rawText: "Alice: Hello" }),
      undefined as any,
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mockRunWithOpenAIFallback).toHaveBeenCalledWith(
      "user-123",
      expect.any(Function),
    );
    expect(data.segments).toHaveLength(1);
  });
});
