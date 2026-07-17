import { withApiHandler } from "@/lib/api-handler";
import { gmailAiWriteResolveContactQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { stripPostgrestOrMetachars } from "@/lib/import-helpers";

/**
 * GET /api/gmail/ai-write/resolve-contact?email=...
 * Resolves a recipient email to a contact ID.
 */
export const GET = withApiHandler({
  querySchema: gmailAiWriteResolveContactQuerySchema,
  authOptional: true,
  handler: async ({ user, query }) => {
    if (!user) return { contactId: null };
    const { email } = query;
    // email is validated as an email by the query schema; strip PostgREST
    // structural metachars before the .or() interpolation below as
    // defense-in-depth (CAR-149, F48). The exact .eq lookups use the raw value
    // (PostgREST parameterizes those, and stripping would corrupt the domain).
    const emailForOr = stripPostgrestOrMetachars(email);

    const service = createSupabaseServiceClient();

    // Try contact_emails table first
    const { data: contactEmail } = await service
      .from("contact_emails")
      .select("contact_id, contacts!inner(user_id)")
      .eq("email", email.toLowerCase())
      .limit(1)
      .single();

    if (contactEmail) {
      // Verify ownership through the join
      const ce = contactEmail as unknown as { contact_id: number; contacts: { user_id: string } };
      if (ce.contacts?.user_id === user.id) {
        return { contactId: ce.contact_id };
      }
    }

    // Fallback: check email_messages for a matched contact
    const { data: emailMsg } = await service
      .from("email_messages")
      .select("matched_contact_id")
      .eq("user_id", user.id)
      .or(`from_address.eq.${emailForOr},to_addresses.cs.{${emailForOr}}`)
      .not("matched_contact_id", "is", null)
      .limit(1)
      .single();

    if (emailMsg?.matched_contact_id) {
      return { contactId: emailMsg.matched_contact_id };
    }

    return { contactId: null };
  },
});
