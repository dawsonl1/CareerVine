import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { selectCadenceCandidates } from "@/lib/apify/cadence";
import { triggerBatchScrape, sweepStuckRuns } from "@/lib/apify/scrape-service";
import { isApifyConfigured } from "@/lib/apify/client";
import { CADENCE_BATCH_SIZE } from "@/lib/constants";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export const maxDuration = 60;

/**
 * POST /api/cron/scrape-refresh
 * Daily QStash schedule (managed in the Upstash console, like
 * send-follow-ups). The cadence drip (plan 29 §7.3):
 *   1. Sweep runs stuck 'pending' >24h to 'timed_out' (lost webhooks) so they
 *      free their contacts and stop reserving budget.
 *   2. Per user: select the ~80 stalest eligible contacts and start batched
 *      profile-mode runs. Runs complete asynchronously via the webhook; a
 *      QStash retry of this route can't double-scrape (in-flight contacts are
 *      excluded from selection; spend is capped per batch).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const swept = await sweepStuckRuns();

  if (process.env.APIFY_SCRAPE_DISABLED === "true" || !isApifyConfigured()) {
    return NextResponse.json({ swept, scraped: 0, disabled: true });
  }

  const service = createSupabaseServiceClient();
  // Suspended = frozen: skipped by server-side automation (admin foundation),
  // same convention as the other crons — and paid scraping doubly so.
  const { data: users } = await service.from("users").select("id").eq("status", "active");

  let scraped = 0;
  const perUser: Record<string, number> = {};
  for (const u of (users as { id: string }[] | null) ?? []) {
    try {
      const candidates = await selectCadenceCandidates(service, u.id);
      let userCount = 0;
      for (let i = 0; i < candidates.length; i += CADENCE_BATCH_SIZE) {
        const started = await triggerBatchScrape(u.id, candidates.slice(i, i + CADENCE_BATCH_SIZE));
        userCount += started;
        if (started === 0) break; // cap reached — no point starting more batches
      }
      if (userCount > 0) perUser[u.id] = userCount;
      scraped += userCount;
    } catch (err) {
      console.error(`[cron scrape-refresh] user ${u.id} failed:`, err);
    }
  }

  return NextResponse.json({ swept, scraped, perUser });
}
