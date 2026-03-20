import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { syncAllContactEmails } from "@/lib/gmail";

/**
 * POST /api/gmail/sync
 * Manually triggers a full Gmail sync for the authenticated user.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const totalSynced = await syncAllContactEmails(user.id);

    return NextResponse.json({ success: true, totalSynced });
  } catch (error) {
    console.error("Gmail sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync Gmail" },
      { status: 500 }
    );
  }
}
