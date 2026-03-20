import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { processScheduledEmails } from "@/lib/gmail";

/**
 * POST /api/gmail/schedule/process
 * Sends all due scheduled emails for the authenticated user.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await processScheduledEmails(user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Scheduled email processing error:", error);
    return NextResponse.json(
      { error: "Failed to process scheduled emails" },
      { status: 500 }
    );
  }
}
