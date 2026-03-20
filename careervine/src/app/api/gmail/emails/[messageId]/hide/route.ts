import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/gmail/emails/[messageId]/hide
 * Hides an email from the webapp only (does not affect Gmail).
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

    const service = createSupabaseServiceClient();
    await service
      .from("email_messages")
      .update({ is_hidden: true })
      .eq("user_id", user.id)
      .eq("gmail_message_id", messageId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Hide email error:", error);
    return NextResponse.json(
      { error: "Failed to hide email" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/gmail/emails/[messageId]/hide
 * Unhides an email, restoring it to the main inbox view.
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

    const service = createSupabaseServiceClient();
    await service
      .from("email_messages")
      .update({ is_hidden: false })
      .eq("user_id", user.id)
      .eq("gmail_message_id", messageId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Unhide email error:", error);
    return NextResponse.json(
      { error: "Failed to unhide email" },
      { status: 500 },
    );
  }
}
