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

interface GeneratedDraft {
  contactId: number;
  draft: {
    id: number;
    contactId: number;
    contactName: string;
    recipientEmail: string | null;
    subject: string;
    bodyHtml: string;
    extractedTopic: string;
    topicEvidence: string;
    sourceMeetingId: number | null;
    articleUrl: string | null;
    articleTitle: string | null;
    articleSource: string | null;
    replyThreadId: string | null;
    replyThreadSubject: string | null;
    sendAsReply: boolean;
  } | null;
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

    // Process contacts sequentially to respect rate limits
    const results: GeneratedDraft[] = [];

    for (const contactId of contactIds) {
      try {
        // Check if a pending draft already exists
        const { data: existing } = await service
          .from("ai_follow_up_drafts")
          .select("id")
          .eq("contact_id", contactId)
          .eq("user_id", user.id)
          .eq("status", AiFollowUpDraftStatus.Pending)
          .limit(1);

        if (existing && existing.length > 0) {
          results.push({ contactId, draft: null, error: "Pending draft already exists" });
          continue;
        }

        // Step 1: Gather context (also verifies ownership)
        const context = await gatherContactContext(user.id, contactId);

        // Step 2: Extract interests
        const interests = await extractInterests(context);

        // Determine the best interest to use
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

        // Get contact's primary email
        const { data: contactEmails } = await service
          .from("contact_emails")
          .select("email")
          .eq("contact_id", contactId)
          .eq("is_primary", true)
          .limit(1);

        const recipientEmail = contactEmails?.[0]?.email || null;

        // Check for recent thread to potentially reply to (within 90 days)
        let replyThreadId: string | null = null;
        let replyThreadSubject: string | null = null;

        if (recipientEmail) {
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

          const { data: recentThreads } = await service
            .from("email_messages")
            .select("thread_id, subject")
            .eq("user_id", user.id)
            .eq("matched_contact_id", contactId)
            .gte("date", ninetyDaysAgo.toISOString())
            .order("date", { ascending: false })
            .limit(1);

          if (recentThreads?.[0]?.thread_id) {
            replyThreadId = recentThreads[0].thread_id;
            replyThreadSubject = recentThreads[0].subject;
          }
        }

        // Default to reply if recent thread exists
        const sendAsReply = replyThreadId !== null;

        // Source meeting is the most recent meeting
        const sourceMeetingId = context.meetings[0]?.id || null;

        // Step 5: Store the draft
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
            extracted_topic: (articleResult?.interest || bestInterest).topic,
            topic_evidence: (articleResult?.interest || bestInterest).evidence,
            source_meeting_id: sourceMeetingId,
            article_url: articleResult?.article.url || null,
            article_title: articleResult?.article.title || null,
            article_source: articleResult?.article.source || null,
            status: AiFollowUpDraftStatus.Pending,
          })
          .select("id")
          .single();

        if (insertError) {
          // Unique constraint violation = draft already exists (race condition)
          if (insertError.code === "23505") {
            results.push({ contactId, draft: null, error: "Pending draft already exists" });
            continue;
          }
          throw insertError;
        }

        results.push({
          contactId,
          draft: {
            id: inserted.id,
            contactId,
            contactName: context.contactName,
            recipientEmail,
            subject: draftResult.subject,
            bodyHtml: draftResult.bodyHtml,
            extractedTopic: (articleResult?.interest || bestInterest).topic,
            topicEvidence: (articleResult?.interest || bestInterest).evidence,
            sourceMeetingId,
            articleUrl: articleResult?.article.url || null,
            articleTitle: articleResult?.article.title || null,
            articleSource: articleResult?.article.source || null,
            replyThreadId,
            replyThreadSubject,
            sendAsReply,
          },
        });
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
