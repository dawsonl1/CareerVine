import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { trashMessage, untrashMessage } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/trash
 * Moves the email to Gmail's trash and marks it trashed locally.
 */
export async function POST(
  _request: NextRequest,
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
    if (!messageId) {
      return NextResponse.json({ error: "messageId is required" }, { status: 400 });
    }

    await trashMessage(user.id, messageId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Trash email error:", error);
    return NextResponse.json(
      { error: "Failed to trash email" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/gmail/emails/[messageId]/trash
 * Restores the email from Gmail's trash (untrash).
 */
export async function DELETE(
  _request: NextRequest,
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
    if (!messageId) {
      return NextResponse.json({ error: "messageId is required" }, { status: 400 });
    }

    await untrashMessage(user.id, messageId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Untrash email error:", error);
    return NextResponse.json(
      { error: "Failed to restore email" },
      { status: 500 },
    );
  }
}
