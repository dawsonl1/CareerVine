/**
 * POST /api/gmail/ai-followups/generate
 *
 * Orchestrates the full AI follow-up pipeline for one or more contacts:
 * 1. Gather context
 * 2. Extract interests
 * 3. Search & evaluate articles (loop)
 * 4. Generate email draft
 * 5. Store in ai_follow_up_drafts
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { aiFollowUpGenerateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { AiFollowUpDraftStatus } from "@/lib/constants";
import { gatherContactContext } from "@/lib/ai-followup/gather-context";
import { extractInterests } from "@/lib/ai-followup/extract-interests";
import { findArticle } from "@/lib/ai-followup/find-article";
import { generateDraft } from "@/lib/ai-followup/generate-draft";

interface GeneratedResult {
  contactId: number;
  /** Matches the snake_case shape from GET /pending so the client uses one type */
  draft: Record<string, unknown> | null;
  error?: string;
}

export const POST = withApiHandler({
  schema: aiFollowUpGenerateSchema,
  handler: async ({ user, body }) => {
    const { contactIds } = body;
    const service = createSupabaseServiceClient();

    // Get user profile for sender name
    const { data: userProfile } = await service
      .from("users")
      .select("first_name, last_name, email")
      .eq("id", user.id)
      .single();

    if (!userProfile) {
      throw new ApiError("User profile not found", 404);
    }

    const senderFirstName = userProfile.first_name || "there";

    // Batch-check which contacts already have pending drafts (single query)
    const { data: existingDrafts } = await service
      .from("ai_follow_up_drafts")
      .select("contact_id")
      .in("contact_id", contactIds)
      .eq("user_id", user.id)
      .eq("status", AiFollowUpDraftStatus.Pending);

    const existingContactIds = new Set((existingDrafts || []).map((d) => d.contact_id));

    // Process contacts sequentially to respect rate limits
    const results: GeneratedResult[] = [];

    for (const contactId of contactIds) {
      if (existingContactIds.has(contactId)) {
        results.push({ contactId, draft: null, error: "Pending draft already exists" });
        continue;
      }

      try {
        // Step 1: Gather context (also verifies ownership)
        const context = await gatherContactContext(user.id, contactId);

        // Step 2: Extract interests
        const interests = await extractInterests(context);

        const bestInterest =
          interests.interests[0] || interests.profileFallbacks[0];

        if (!bestInterest) {
          results.push({ contactId, draft: null, error: "No interests could be extracted" });
          continue;
        }

        // Step 3: Search & evaluate loop
        const articleResult = await findArticle(interests);

        // Step 4: Generate email draft
        const draftResult = await generateDraft({
          senderFirstName,
          senderEmail: userProfile.email || "",
          contact: context,
          interest: articleResult?.interest || bestInterest,
          article: articleResult?.article,
        });

        // Get contact's primary email + check for recent thread in parallel
        const recipientEmailPromise = service
          .from("contact_emails")
          .select("email")
          .eq("contact_id", contactId)
          .eq("is_primary", true)
          .limit(1);

        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        const recentThreadPromise = service
          .from("email_messages")
          .select("thread_id, subject")
          .eq("user_id", user.id)
          .eq("matched_contact_id", contactId)
          .gte("date", ninetyDaysAgo.toISOString())
          .order("date", { ascending: false })
          .limit(1);

        const [emailResult, threadResult] = await Promise.all([
          recipientEmailPromise,
          recentThreadPromise,
        ]);

        const recipientEmail = emailResult.data?.[0]?.email || null;
        const replyThreadId = threadResult.data?.[0]?.thread_id || null;
        const replyThreadSubject = threadResult.data?.[0]?.subject || null;
        const sendAsReply = replyThreadId !== null;
        const sourceMeetingId = context.meetings[0]?.id || null;
        const usedInterest = articleResult?.interest || bestInterest;

        // Step 5: Store and return the full row (same shape as GET /pending)
        const { data: inserted, error: insertError } = await service
          .from("ai_follow_up_drafts")
          .insert({
            user_id: user.id,
            contact_id: contactId,
            recipient_email: recipientEmail,
            subject: draftResult.subject,
            body_html: draftResult.bodyHtml,
            reply_thread_id: replyThreadId,
            reply_thread_subject: replyThreadSubject,
            send_as_reply: sendAsReply,
            extracted_topic: usedInterest.topic,
            topic_evidence: usedInterest.evidence,
            source_meeting_id: sourceMeetingId,
            article_url: articleResult?.article.url || null,
            article_title: articleResult?.article.title || null,
            article_source: articleResult?.article.source || null,
            status: AiFollowUpDraftStatus.Pending,
          })
          .select(`
            id, contact_id, recipient_email, subject, body_html,
            reply_thread_id, reply_thread_subject, send_as_reply,
            extracted_topic, topic_evidence, source_meeting_id,
            article_url, article_title, article_source,
            status, created_at,
            contacts(name, photo_url, industry)
          `)
          .single();

        if (insertError) {
          if (insertError.code === "23505") {
            results.push({ contactId, draft: null, error: "Pending draft already exists" });
            continue;
          }
          throw insertError;
        }

        results.push({ contactId, draft: inserted });
      } catch (err) {
        console.error(`[AI Follow-Up] Failed to generate draft for contact ${contactId}:`, err);
        results.push({
          contactId,
          draft: null,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { success: true, results };
  },
});
