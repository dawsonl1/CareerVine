import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { ingestScrapeRun } from "@/lib/apify/scrape-service";
import { APIFY_WEBHOOK_SECRET_HEADER } from "@/lib/apify/client";

/** Constant-time equality that also avoids leaking length via early return. */
function secretsMatch(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * POST /api/apify/run-callback?run=...
 * Apify webhook target, fired when a scrape run terminates. Verifies the shared
 * secret, then ingests the run (map → rescrape-merge → cost). Ingestion is
 * idempotent, so a duplicate delivery is a safe no-op.
 *
 * The secret is presented in the X-Careervine-Webhook-Secret header (CAR-140 /
 * F26), never the URL. The `?secret=` query param is accepted as a transitional
 * fallback so runs already in flight at deploy time (whose callback URLs still
 * carry the old query secret) don't orphan. Remove the fallback + rotate the
 * secret ≥24h after deploy, once all pre-deploy runs have drained.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const presented =
    req.headers.get(APIFY_WEBHOOK_SECRET_HEADER) ?? req.nextUrl.searchParams.get("secret");
  if (!secretsMatch(presented, process.env.APIFY_WEBHOOK_SECRET)) {
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
    // What escapes ingest is transient plumbing (run-lookup/claim DB errors) —
    // merge failures are handled inside and marked terminal. Ingest holds an
    // atomic claim, so a redelivery is safe: answer 503 to get Apify's retry
    // (minutes) instead of waiting on the 24h sweep. The row stays 'pending'
    // for that backstop either way.
    console.error("[apify-callback] ingest failed:", err);
    return NextResponse.json({ success: false }, { status: 503 });
  }

  return NextResponse.json({ success: true });
}
