import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";

export const maxDuration = 60;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

/**
 * POST /api/cron/send-scheduled-emails
 * Called by QStash every 15 minutes. Processes due scheduled emails
 * across users so delivery does not depend on UI activity.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const result = await processDueScheduledEmails();
  return NextResponse.json(result);
}
