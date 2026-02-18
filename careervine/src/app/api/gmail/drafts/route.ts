import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/drafts
 * Returns all drafts for the current user, ordered by most recently updated.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ drafts: [] });

    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("email_drafts")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ drafts: data || [] });
  } catch (error) {
    console.error("Drafts fetch error:", error);
    return NextResponse.json({ drafts: [] });
  }
}

/**
 * POST /api/gmail/drafts
 * Create or update a draft. If body includes `id`, update that draft; otherwise create new.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const service = createSupabaseServiceClient();

    const draftData = {
      user_id: user.id,
      recipient_email: body.to || null,
      cc: body.cc || null,
      bcc: body.bcc || null,
      subject: body.subject || null,
      body_html: body.bodyHtml || null,
      thread_id: body.threadId || null,
      in_reply_to: body.inReplyTo || null,
      references_header: body.references || null,
      contact_name: body.contactName || null,
    };

    if (body.id) {
      // Update existing draft
      const { data, error } = await service
        .from("email_drafts")
        .update({ ...draftData, updated_at: new Date().toISOString() })
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, draft: data });
    } else {
      // Create new draft
      const { data, error } = await service
        .from("email_drafts")
        .insert(draftData)
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, draft: data });
    }
  } catch (error) {
    console.error("Draft save error:", error);
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }
}
