import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { moveMessageToLabel } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/move
 * Moves an email to a Gmail label/folder and removes it from the webapp.
 * Body: { labelId: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messageId } = await params;
    const { labelId } = await request.json();

    if (!messageId || !labelId) {
      return NextResponse.json({ error: "messageId and labelId are required" }, { status: 400 });
    }

    await moveMessageToLabel(user.id, messageId, labelId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Move email error:", error);
    return NextResponse.json(
      { error: "Failed to move email" },
      { status: 500 },
    );
  }
}
