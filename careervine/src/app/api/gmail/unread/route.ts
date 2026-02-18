import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/unread
 * Returns the count of unread inbound emails for the current user.
 * Lightweight endpoint used by the navigation badge.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ count: 0 });
    }

    const service = createSupabaseServiceClient();
    const { count, error } = await service
      .from("email_messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false)
      .eq("direction", "inbound");

    if (error) throw error;

    return NextResponse.json({ count: count || 0 });
  } catch (error) {
    console.error("Unread count error:", error);
    return NextResponse.json({ count: 0 });
  }
}
