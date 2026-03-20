import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Set env before import
vi.stubEnv("SERPER_API_KEY", "test-key");

import { searchNews, searchWeb } from "@/lib/serper";

describe("serper", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("searchNews", () => {
    it("returns normalized results from Serper news endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          news: [
            {
              title: "Credit Card Points Guide",
              link: "https://example.com/article",
              snippet: "A comprehensive guide to maximizing points.",
              source: "NerdWallet",
              date: "2 hours ago",
            },
          ],
        }),
      });

      const results = await searchNews("credit card points");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://google.serper.dev/news",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-API-KEY": "test-key" }),
        }),
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        title: "Credit Card Points Guide",
        url: "https://example.com/article",
        snippet: "A comprehensive guide to maximizing points.",
        source: "NerdWallet",
        date: "2 hours ago",
      });
    });

    it("returns empty array when no news results", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ news: [] }),
      });

      const results = await searchNews("obscure topic");
      expect(results).toHaveLength(0);
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      await expect(searchNews("test")).rejects.toThrow("Serper news search failed: 429");
    });
  });

  describe("searchWeb", () => {
    it("returns normalized results from Serper search endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic: [
            {
              title: "Marathon Training Plan",
              link: "https://runnersworld.com/training",
              snippet: "Everything you need to know about training.",
            },
          ],
        }),
      });

      const results = await searchWeb("marathon training");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://google.serper.dev/search",
        expect.objectContaining({ method: "POST" }),
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        title: "Marathon Training Plan",
        url: "https://runnersworld.com/training",
        snippet: "Everything you need to know about training.",
        source: "runnersworld.com",
      });
    });

    it("extracts hostname as source", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic: [
            {
              title: "Test",
              link: "https://www.nytimes.com/article",
              snippet: "Test snippet",
            },
          ],
        }),
      });

      const results = await searchWeb("test");
      expect(results[0].source).toBe("nytimes.com");
    });
  });
});
