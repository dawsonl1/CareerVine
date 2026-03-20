import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { processFollowUps } from "@/lib/gmail";

/**
 * POST /api/gmail/follow-ups/process
 * Processes all due follow-up messages for the authenticated user.
 * Checks for replies before sending each follow-up.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await processFollowUps(user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Follow-up processing error:", error);
    return NextResponse.json(
      { error: "Failed to process follow-ups" },
      { status: 500 }
    );
  }
}
