import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";
import { withCronGuard } from "@/lib/cron-guard";

export const maxDuration = 60;

/**
 * POST /api/cron/send-scheduled-emails
 * Called by QStash every 15 minutes. Processes due scheduled emails
 * across users so delivery does not depend on UI activity.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () => withCronGuard("/api/cron/send-scheduled-emails", async () => {
    const result = await processDueScheduledEmails();
    return NextResponse.json(result);
  }));
}
