import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sweepStorageOrphans } from "@/lib/storage-sweep";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export const maxDuration = 60;

/**
 * POST /api/cron/storage-sweep
 * Daily QStash schedule (managed in the Upstash console, like the other
 * crons). Reconciles Supabase Storage against the DB (CAR-69): objects in the
 * attachments / application-files buckets with no matching row are orphans
 * left behind by cascade deletes, and get removed. Idempotent; objects
 * younger than 24h are never touched (upload-before-insert race).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return withCronGuard("/api/cron/storage-sweep", async () => {
    const service = createSupabaseServiceClient();
    const result = await sweepStorageOrphans({ service });
    return NextResponse.json(result);
  });
}
