/**
 * CAR-140 (F26): the Apify completion webhook authenticates via the
 * X-Careervine-Webhook-Secret header. During the transition deploy it also
 * accepts the legacy `?secret=` query param so runs already in flight (whose
 * callback URLs still carry the query secret) don't orphan. Header wins when
 * present; a wrong/missing credential is rejected before any ingest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ingestScrapeRun = vi.fn(async () => undefined);
vi.mock("@/lib/apify/scrape-service", () => ({
  ingestScrapeRun: (...args: unknown[]) => ingestScrapeRun(...(args as [])),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/apify/run-callback/route";
import { APIFY_WEBHOOK_SECRET_HEADER } from "@/lib/apify/client";

const SECRET = "webhook-secret";

function makeReq(opts: { header?: string; query?: string; run?: string }) {
  const url = new URL("http://localhost/api/apify/run-callback");
  if (opts.query !== undefined) url.searchParams.set("secret", opts.query);
  url.searchParams.set("run", opts.run ?? "42");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.header !== undefined) headers[APIFY_WEBHOOK_SECRET_HEADER] = opts.header;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ eventData: { actorRunId: "run-abc" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APIFY_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/apify/run-callback auth", () => {
  it("accepts a valid secret in the header and ingests", async () => {
    const res = await POST(makeReq({ header: SECRET }));
    expect(res.status).toBe(200);
    expect(ingestScrapeRun).toHaveBeenCalledWith({ scrapeRunId: 42, apifyRunId: "run-abc" });
  });

  it("accepts the legacy query-param secret (in-flight run fallback)", async () => {
    const res = await POST(makeReq({ query: SECRET }));
    expect(res.status).toBe(200);
    expect(ingestScrapeRun).toHaveBeenCalledTimes(1);
  });

  it("prefers the header when both are present", async () => {
    const res = await POST(makeReq({ header: SECRET, query: "wrong" }));
    expect(res.status).toBe(200);
  });

  it("rejects a wrong header with no query fallback", async () => {
    const res = await POST(makeReq({ header: "nope" }));
    expect(res.status).toBe(401);
    expect(ingestScrapeRun).not.toHaveBeenCalled();
  });

  it("rejects when neither header nor query secret is present", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
    expect(ingestScrapeRun).not.toHaveBeenCalled();
  });
});
