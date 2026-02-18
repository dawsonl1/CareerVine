import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/ai-write/meetings?contactId=...
 * Returns meetings associated with a contact (that belong to the current user).
 */
export async function GET(request: NextRequest) {
  try {
    const contactId = request.nextUrl.searchParams.get("contactId");
    if (!contactId) return NextResponse.json({ meetings: [] });

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ meetings: [] });

    const service = createSupabaseServiceClient();

    // Get meeting IDs for this contact
    const { data: links } = await service
      .from("meeting_contacts")
      .select("meeting_id")
      .eq("contact_id", parseInt(contactId));

    if (!links?.length) return NextResponse.json({ meetings: [] });

    const meetingIds = links.map((l) => l.meeting_id);

    // Fetch the actual meetings (owned by user, with notes or transcripts)
    const { data: meetings } = await service
      .from("meetings")
      .select("id, meeting_date, meeting_type, notes, transcript")
      .eq("user_id", user.id)
      .in("id", meetingIds)
      .order("meeting_date", { ascending: false })
      .limit(20);

    // Only return meetings that have useful content
    const useful = (meetings || []).filter((m) => m.notes || m.transcript);

    return NextResponse.json({ meetings: useful });
  } catch {
    return NextResponse.json({ meetings: [] });
  }
}
