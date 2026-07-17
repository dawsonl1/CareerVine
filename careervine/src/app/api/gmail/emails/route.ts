import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailEmailsQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getConnection } from "@/lib/gmail-send-core";
import { syncEmailsForContact, backfillEmailsForContact } from "@/lib/gmail";
import { resolveCapabilities } from "@/lib/capabilities/resolve";

/**
 * GET /api/gmail/emails?contactId=xxx
 * Returns cached email metadata for a contact. Triggers a background
 * re-sync if the last sync was more than 15 minutes ago.
 *
 * Intentionally NOT gated by requireCapability (CAR-102): the response is a
 * DB read of the user's own cached history that the free Outreach per-contact
 * view depends on. Only the live re-sync below is premium — that is skipped
 * in-handler for users without mailbox:read.
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
    const numericContactId = parseInt(contactId);

    // Verify the contact belongs to this user before touching it. The service
    // client bypasses RLS, so an unscoped read by raw contactId is an IDOR:
    // it would leak a foreign contact's email addresses and kick off background
    // sync/backfill jobs against them (CAR-133 / R2.6).
    const { data: ownedContact } = await serviceClient
      .from("contacts")
      .select("id")
      .eq("id", numericContactId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!ownedContact) {
      throw new ApiError("Contact not found", 404);
    }

    // Get the contact's email addresses
    const { data: contactEmails } = await serviceClient
      .from("contact_emails")
      .select("email")
      .eq("contact_id", numericContactId);

    const emails = (contactEmails || [])
      .map((e: { email: string | null }) => e.email)
      .filter(Boolean) as string[];

    // Check if we need a re-sync (stale after 15 min)
    const STALE_MS = 15 * 60 * 1000;
    const lastSync = conn.last_gmail_sync_at
      ? new Date(conn.last_gmail_sync_at).getTime()
      : 0;
    const isStale = Date.now() - lastSync > STALE_MS;

    if (emails.length > 0) {
      // Claim any orphaned emails that match this contact's addresses
      backfillEmailsForContact(user.id, numericContactId, emails)
        .catch((err) => console.error("Email backfill error:", err));

      if (isStale) {
        // Live re-sync is premium only (CAR-102) — it needs the gmail.modify
        // read scope. Free users get their cached history from the DB read
        // below; skip the background sync (it would 403 anyway).
        const caps = await resolveCapabilities(user.id);
        if (caps.has("mailbox:read")) {
          // Sync in the background — don't block the response
          syncEmailsForContact(
            user.id,
            numericContactId,
            emails,
            conn.gmail_address,
            90
          ).catch((err) => console.error("Background sync error:", err));
        }
      }
    }

    // Return cached emails (exclude trashed/hidden)
    const { data: messages, error: queryError } = await serviceClient
      .from("email_messages")
      .select("*")
      .eq("user_id", user.id)
      .eq("matched_contact_id", numericContactId)
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
