/**
 * GET /api/gmail/ai-followups/pending
 *
 * Returns all pending AI follow-up drafts for the current user,
 * joined with contact name and photo for dashboard display.
 */

import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { AiFollowUpDraftStatus } from "@/lib/constants";

export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    const { data: drafts, error } = await service
      .from("ai_follow_up_drafts")
      .select(`
        id, contact_id, recipient_email, subject, body_html,
        reply_thread_id, reply_thread_subject, send_as_reply,
        extracted_topic, topic_evidence, source_meeting_id,
        article_url, article_title, article_source,
        status, created_at,
        contacts(name, photo_url, industry)
      `)
      .eq("user_id", user.id)
      .eq("status", AiFollowUpDraftStatus.Pending)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return { success: true, drafts: drafts || [] };
  },
});
