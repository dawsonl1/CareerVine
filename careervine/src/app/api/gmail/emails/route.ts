import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailEmailsQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getConnection, syncEmailsForContact } from "@/lib/gmail";

/**
 * GET /api/gmail/emails?contactId=xxx
 * Returns cached email metadata for a contact. Triggers a background
 * re-sync if the last sync was more than 15 minutes ago.
 */
export const GET = withApiHandler({
  querySchema: gmailEmailsQuerySchema,
  handler: async ({ user, query }) => {
    const { contactId } = query;

    const conn = await getConnection(user.id);
    if (!conn) {
      throw new ApiError("Gmail not connected", 400);
    }

    const serviceClient = createSupabaseServiceClient();

    // Get the contact's email addresses
    const { data: contactEmails } = await serviceClient
      .from("contact_emails")
      .select("email")
      .eq("contact_id", parseInt(contactId));

    const emails = (contactEmails || [])
      .map((e: { email: string | null }) => e.email)
      .filter(Boolean) as string[];

    // Check if we need a re-sync (stale after 15 min)
    const STALE_MS = 15 * 60 * 1000;
    const lastSync = conn.last_gmail_sync_at
      ? new Date(conn.last_gmail_sync_at).getTime()
      : 0;
    const isStale = Date.now() - lastSync > STALE_MS;

    if (isStale && emails.length > 0) {
      // Sync in the background — don't block the response
      syncEmailsForContact(
        user.id,
        parseInt(contactId),
        emails,
        conn.gmail_address,
        90
      ).catch((err) => console.error("Background sync error:", err));
    }

    // Return cached emails (exclude trashed/hidden)
    const { data: messages, error: queryError } = await serviceClient
      .from("email_messages")
      .select("*")
      .eq("user_id", user.id)
      .eq("matched_contact_id", parseInt(contactId))
      .eq("is_trashed", false)
      .eq("is_hidden", false)
      .order("date", { ascending: false });

    if (queryError) throw queryError;

    return {
      success: true,
      emails: messages || [],
      isStale,
      gmailAddress: conn.gmail_address,
    };
  },
});
