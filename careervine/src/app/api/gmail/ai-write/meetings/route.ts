import { withApiHandler } from "@/lib/api-handler";
import { gmailAiWriteMeetingsQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/ai-write/meetings?contactId=...
 * Returns meetings associated with a contact (that belong to the current user).
 */
export const GET = withApiHandler({
  querySchema: gmailAiWriteMeetingsQuerySchema,
  authOptional: true,
  handler: async ({ user, query }) => {
    if (!user) return { meetings: [] };
    const { contactId } = query;

    const service = createSupabaseServiceClient();

    // Get meeting IDs for this contact
    const { data: links } = await service
      .from("meeting_contacts")
      .select("meeting_id")
      .eq("contact_id", parseInt(contactId));

    if (!links?.length) return { meetings: [] };

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

    return { meetings: useful };
  },
});
