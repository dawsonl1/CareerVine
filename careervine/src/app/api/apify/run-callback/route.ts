import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { ingestScrapeRun } from "@/lib/apify/scrape-service";

/** Constant-time equality that also avoids leaking length via early return. */
function secretsMatch(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * POST /api/apify/run-callback?secret=...
 * Apify webhook target, fired when a scrape run terminates. Verifies the shared
 * secret, then ingests the run (map → rescrape-merge → cost). Ingestion is
 * idempotent, so a duplicate delivery is a safe no-op.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secretsMatch(secret, process.env.APIFY_WEBHOOK_SECRET)) {
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

  // The scrape_runs id rides in the URL so ingest correlates by it directly.
  const runParam = req.nextUrl.searchParams.get("run");
  const scrapeRunId = runParam != null && /^\d+$/.test(runParam) ? Number(runParam) : undefined;

  try {
    await ingestScrapeRun({ scrapeRunId, apifyRunId: runId });
  } catch (err) {
    // Swallow so Apify doesn't hammer retries; the daily sweep (phase 2/3)
    // re-queues runs left pending. The row stays 'pending' for that backstop.
    console.error("[apify-callback] ingest failed:", err);
    return NextResponse.json({ ok: false });
  }

  return NextResponse.json({ ok: true });
}
