import { NextRequest, NextResponse } from "next/server";
import { ingestScrapeRun } from "@/lib/apify/scrape-service";

/**
 * POST /api/apify/run-callback?secret=...
 * Apify webhook target, fired when a scrape run terminates. Verifies the shared
 * secret, then ingests the run (map → rescrape-merge → cost). Ingestion is
 * idempotent, so a duplicate delivery is a safe no-op.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const expected = process.env.APIFY_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let runId: string | null = null;
  try {
    const body = (await req.json()) as {
      eventData?: { actorRunId?: string };
      resource?: { id?: string };
    };
    runId = body?.eventData?.actorRunId ?? body?.resource?.id ?? null;
  } catch {
    // fall through — no parseable body
  }
  if (!runId) return NextResponse.json({ error: "no run id" }, { status: 400 });

  try {
    await ingestScrapeRun(runId);
  } catch (err) {
    // Swallow so Apify doesn't hammer retries; the daily sweep (phase 2/3)
    // re-queues runs left pending. The row stays 'pending' for that backstop.
    console.error("[apify-callback] ingest failed:", err);
    return NextResponse.json({ ok: false });
  }

  return NextResponse.json({ ok: true });
}
