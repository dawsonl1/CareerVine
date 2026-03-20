import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getConnection } from "@/lib/gmail";

/**
 * GET /api/gmail/inbox
 * Returns all email messages for the user (across every contact),
 * all pending scheduled emails, and all active follow-up sequences.
 * Used by the unified Inbox page.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const conn = await getConnection(user.id);
    if (!conn) {
      throw new ApiError("Gmail not connected", 400);
    }

    const service = createSupabaseServiceClient();

    const [emailsRes, trashedRes, hiddenRes, scheduledRes, followUpsRes, contactsRes, calendarEventsRes] = await Promise.all([
      service
        .from("email_messages")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_trashed", false)
        .eq("is_hidden", false)
        .order("date", { ascending: false })
        .limit(500),

      service
        .from("email_messages")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_trashed", true)
        .order("date", { ascending: false })
        .limit(100),

      service
        .from("email_messages")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_hidden", true)
        .eq("is_trashed", false)
        .order("date", { ascending: false })
        .limit(100),

      service
        .from("scheduled_emails")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .order("scheduled_send_at", { ascending: true }),

      service
        .from("email_follow_ups")
        .select("*, email_follow_up_messages(*)")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: false }),

      // Lightweight contact lookup: id → name
      service
        .from("contacts")
        .select("id, name")
        .eq("user_id", user.id),

      // Calendar events linked to email threads
      service
        .from("calendar_events")
        .select("source_gmail_thread_id, id, title, start_at, google_event_id")
        .eq("user_id", user.id)
        .not("source_gmail_thread_id", "is", null),
    ]);

    if (emailsRes.error) throw emailsRes.error;
    if (trashedRes.error) throw trashedRes.error;
    if (hiddenRes.error) throw hiddenRes.error;
    if (scheduledRes.error) throw scheduledRes.error;
    if (followUpsRes.error) throw followUpsRes.error;

    const contactMap: Record<number, string> = {};
    for (const c of contactsRes.data || []) {
      contactMap[c.id] = c.name;
    }

    const calendarByThread: Record<string, { id: number; title: string | null; start_at: string; google_event_id: string }> = {};
    for (const ce of calendarEventsRes.data || []) {
      if (ce.source_gmail_thread_id) {
        calendarByThread[ce.source_gmail_thread_id] = {
          id: ce.id,
          title: ce.title,
          start_at: ce.start_at,
          google_event_id: ce.google_event_id,
        };
      }
    }

    return {
      success: true,
      emails: emailsRes.data || [],
      trashedEmails: trashedRes.data || [],
      hiddenEmails: hiddenRes.data || [],
      scheduledEmails: scheduledRes.data || [],
      followUps: followUpsRes.data || [],
      contactMap,
      calendarByThread,
      gmailAddress: conn.gmail_address,
    };
  },
});
