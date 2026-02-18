import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/gmail/drafts/:id
 * Delete a specific draft by ID.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const service = createSupabaseServiceClient();
    const { error } = await service
      .from("email_drafts")
      .delete()
      .eq("id", parseInt(id))
      .eq("user_id", user.id);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Draft delete error:", error);
    return NextResponse.json({ error: "Failed to delete draft" }, { status: 500 });
  }
}
