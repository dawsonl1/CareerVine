import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { getGmailLabels } from "@/lib/gmail";

/**
 * GET /api/gmail/labels
 * Returns the user's Gmail labels/folders for the "Move to" UI.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const labels = await getGmailLabels(user.id);
    return NextResponse.json({ labels });
  } catch (error) {
    console.error("Gmail labels error:", error);
    return NextResponse.json(
      { error: "Failed to fetch labels" },
      { status: 500 },
    );
  }
}
