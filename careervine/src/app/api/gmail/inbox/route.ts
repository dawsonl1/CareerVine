import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getConnection } from "@/lib/gmail-send-core";
import {
  loadContactEmploymentMap,
  resolveEmailsToContactIds,
} from "@/lib/contact-employment";

/**
 * GET /api/gmail/inbox
 * Returns all email messages for the user (across every contact),
 * all pending scheduled emails, and all active follow-up sequences.
 * Used by the unified Inbox page and free Outreach portal.
 *
 * CAR-127: also returns contactDetails (current role/company/office) for every
 * contact referenced by a matched_contact_id or resolvable recipient email.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const conn = await getConnection(user.id);
    if (!conn) {
      throw new ApiError("Gmail not connected", 400);
    }

    const service = createSupabaseServiceClient();

    // Junction embed (CAR-169): each message carries every tracked contact it
    // is attributed to, so the inbox contact filter can surface a shared thread
    // under all involved contacts, not just the denormalized primary. Plain
    // embed (not !inner) so messages with no links yet still return.
    const emailSelect = "*, email_message_contacts(contact_id)";
    const [emailsRes, trashedRes, hiddenRes, scheduledRes, followUpsRes, contactsRes, calendarEventsRes] = await Promise.all([
      service
        .from("email_messages")
        .select(emailSelect)
        .eq("user_id", user.id)
        .eq("is_trashed", false)
        .eq("is_hidden", false)
        .order("date", { ascending: false })
        .limit(500),

      service
        .from("email_messages")
        .select(emailSelect)
        .eq("user_id", user.id)
        .eq("is_trashed", true)
        .order("date", { ascending: false })
        .limit(100),

      service
        .from("email_messages")
        .select(emailSelect)
        .eq("user_id", user.id)
        .eq("is_hidden", true)
        .eq("is_trashed", false)
        .order("date", { ascending: false })
        .limit(100),

      service
        .from("scheduled_emails")
        .select("*")
        .eq("user_id", user.id)
        // failed = stale send claim swept by the cron (CAR-134); shown with a
        // Retry action so it never vanishes silently. 'sending' is transient
        // and intentionally hidden.
        .in("status", ["pending", "failed"])
        .order("scheduled_send_at", { ascending: true }),

      service
        .from("email_follow_ups")
        .select("*, email_follow_up_messages(*)")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: false }),

      // Lightweight contact lookup: id → name (kept for paid Inbox filters)
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

    // Flatten the junction embed into a contact_ids array (union with the
    // denormalized primary, which covers rows not yet linked), and strip the
    // embed so the row shape stays otherwise identical to before (CAR-169).
    type EmbeddedRow = Record<string, unknown> & {
      email_message_contacts?: Array<{ contact_id: number | null }> | null;
      matched_contact_id?: number | null;
    };
    const withContactIds = (rows: EmbeddedRow[] | null | undefined) =>
      (rows || []).map(({ email_message_contacts, ...rest }) => {
        const ids = new Set<number>();
        for (const l of email_message_contacts ?? []) {
          if (l.contact_id != null) ids.add(l.contact_id);
        }
        if (rest.matched_contact_id != null) ids.add(rest.matched_contact_id);
        return { ...rest, contact_ids: [...ids] };
      });

    const emails = withContactIds(emailsRes.data as EmbeddedRow[]);
    const trashedEmails = withContactIds(trashedRes.data as EmbeddedRow[]);
    const hiddenEmails = withContactIds(hiddenRes.data as EmbeddedRow[]);
    const scheduledEmails = scheduledRes.data || [];
    const followUpsRaw = followUpsRes.data || [];

    const contactMap: Record<number, string> = {};
    for (const c of contactsRes.data || []) {
      contactMap[c.id] = c.name;
    }

    // Resolve follow-up (and any scheduled without matched_contact_id) emails → contacts.
    const emailsNeedingIds = [
      ...followUpsRaw.map((f: { recipient_email?: string | null }) => f.recipient_email),
      ...scheduledEmails
        .filter((s: { matched_contact_id?: number | null }) => !s.matched_contact_id)
        .map((s: { recipient_email?: string | null }) => s.recipient_email),
    ];
    const emailToContact = await resolveEmailsToContactIds(service, user.id, emailsNeedingIds);

    const followUps = followUpsRaw.map((f: { recipient_email?: string | null }) => {
      const matched =
        (f.recipient_email && emailToContact.get(f.recipient_email.toLowerCase())) || null;
      return { ...f, matched_contact_id: matched };
    });

    const scheduledEnriched = scheduledEmails.map(
      (s: { matched_contact_id?: number | null; recipient_email?: string | null }) => {
        if (s.matched_contact_id) return s;
        const matched =
          (s.recipient_email && emailToContact.get(s.recipient_email.toLowerCase())) || null;
        return matched ? { ...s, matched_contact_id: matched } : s;
      },
    );

    const idSet = new Set<number>();
    // Every attributed contact (all junction links, CAR-169), so co-recipients
    // on a shared thread also get their employment details loaded for the row.
    for (const e of [...emails, ...trashedEmails, ...hiddenEmails]) {
      for (const id of e.contact_ids) idSet.add(id);
    }
    for (const s of scheduledEnriched) {
      if (s.matched_contact_id) idSet.add(s.matched_contact_id);
    }
    for (const f of followUps) {
      if (f.matched_contact_id) idSet.add(f.matched_contact_id);
    }

    const contactDetails = await loadContactEmploymentMap(service, user.id, [...idSet]);
    // Ensure every id we know a name for appears (even with no current job).
    for (const [idStr, name] of Object.entries(contactMap)) {
      const id = Number(idStr);
      if (!contactDetails[id] && idSet.has(id)) {
        contactDetails[id] = {
          id,
          name,
          title: null,
          company_id: null,
          company_name: null,
          location_label: null,
        };
      }
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
      emails,
      trashedEmails,
      hiddenEmails,
      scheduledEmails: scheduledEnriched,
      followUps,
      contactMap,
      contactDetails,
      calendarByThread,
      gmailAddress: conn.gmail_address,
    };
  },
});
