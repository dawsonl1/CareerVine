import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sweepStorageOrphans, sweepR2PhotoOrphans } from "@/lib/storage-sweep";

export const maxDuration = 60;

/**
 * POST /api/cron/storage-sweep
 * Daily QStash schedule (source of truth: scripts/qstash-schedules.mjs).
 * Reconciles Supabase Storage against the DB (CAR-69): objects in the
 * attachments / application-files buckets with no matching row are orphans
 * left behind by cascade deletes, and get removed. Also reconciles the R2
 * contact-photo prefix against contacts.photo_url (CAR-156) — the public
 * CDN copy of a deleted user's or contact's photo must not outlive the row.
 * Idempotent; objects younger than 24h are never touched
 * (upload-before-insert race).
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () => withCronGuard("/api/cron/storage-sweep", async () => {
    const service = createSupabaseServiceClient();
    const result = await sweepStorageOrphans({ service });
    const r2 = await sweepR2PhotoOrphans({ service });
    return NextResponse.json({ ...result, r2 });
  }));
}
