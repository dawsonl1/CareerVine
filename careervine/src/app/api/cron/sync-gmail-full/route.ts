import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { runFullSyncSweep } from "@/lib/gmail-sync-cron";

export const maxDuration = 60;

/**
 * POST /api/cron/sync-gmail-full
 *
 * Full Gmail sweep for every premium user, driven from the A1 box (CAR-234).
 * Owns cold inbound from contacts the user never emailed, and owns bounce
 * detection, which is not contact-scoped and so cannot run on the narrow sweep.
 *
 * The cadence lives in `ops/gmail-sync/careervine-sync-full.timer` and its
 * service's hour list, not here.
 *
 * ── Why this is a separate route from the narrow sweep ───────────────────
 *
 * Not a `mode` on one endpoint. `allowCronBearer` admits a caller holding
 * `$CRON_TRIGGER_SECRET`, and that path carries NO body signature, so on an
 * opted-in route the body is chosen by whoever holds the secret. A handler that
 * trusts its body must not opt in (see the `qstash-verify.ts` header). Two
 * routes that each select their own work server-side keeps the body irrelevant
 * to what runs, which is what makes opting in safe here.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(
    req,
    (_body, source) =>
      withCronGuard("/api/cron/sync-gmail-full", async () => {
        const result = await runFullSyncSweep(createSupabaseServiceClient());
        return NextResponse.json({ ...result, driver: source });
      }),
    { allowCronBearer: true },
  );
}
