import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getConnection } from "@/lib/gmail-send-core";
import {
  loadContactEmploymentMap,
  resolveEmailsToContactIds,
} from "@/lib/contact-employment";
import { chunkList } from "@/lib/data/postgrest";

/**
 * GET /api/gmail/inbox
 * Returns all email messages for the user (across every contact),
 * all pending scheduled emails, and all active follow-up sequences.
 * Used by the unified Inbox page and free Outreach portal.
 *
 * CAR-127: also returns contactDetails (current role/company/office) for every
 * contact referenced by a matched_contact_id or resolvable recipient email.
 *
 * CAR-221: every read here is scoped to what the payload actually references.
 * Nothing selects a whole user-owned table, because PostgREST caps a response
 * at 1000 rows and truncates it silently (CONVENTIONS.md / postgrest.ts).
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
    const [emailsRes, trashedRes, hiddenRes, scheduledRes, followUpsRes] = await Promise.all([
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
    ]);

    if (emailsRes.error) throw emailsRes.error;
    if (trashedRes.error) throw trashedRes.error;
    if (hiddenRes.error) throw hiddenRes.error;
    if (scheduledRes.error) throw scheduledRes.error;
    if (followUpsRes.error) throw followUpsRes.error;

    // Flatten the junction embed into a contact_ids array (union with the
    // denormalized primary, which covers rows not yet linked), and strip the
    // embed so the row shape stays otherwise identical to before (CAR-169).
    //
    // Generic over the row rather than taking `Record<string, unknown> & {...}`
    // (CAR-199). That intersection needed an `as` at all three call sites, and
    // the index signature did not survive the `{ ...rest }` spread, so the
    // handler's inferred return said an email message had `contact_ids` and
    // nothing else. Consumers could not then use `InferApiResponse<typeof GET>`
    // at all, which is the seam CAR-158 built. Preserving T keeps every column.
    const withContactIds = <
      T extends {
        email_message_contacts?: Array<{ contact_id: number | null }> | null;
        matched_contact_id?: number | null;
      },
    >(
      rows: T[] | null | undefined,
    ): Array<Omit<T, "email_message_contacts"> & { contact_ids: number[] }> =>
      (rows || []).map(({ email_message_contacts, ...rest }) => {
        const ids = new Set<number>();
        for (const l of email_message_contacts ?? []) {
          if (l.contact_id != null) ids.add(l.contact_id);
        }
        if (rest.matched_contact_id != null) ids.add(rest.matched_contact_id);
        return { ...rest, contact_ids: [...ids] };
      });

    const emails = withContactIds(emailsRes.data);
    const trashedEmails = withContactIds(trashedRes.data);
    const hiddenEmails = withContactIds(hiddenRes.data);
    const scheduledEmails = scheduledRes.data || [];
    const followUpsRaw = followUpsRes.data || [];

    // Resolve follow-up (and any scheduled without matched_contact_id) emails → contacts.
    // No parameter annotations here or below (CAR-199): they named one field
    // being read, and the cost was that a `{ ...f }` spread then carried only
    // that field into the response type. The element type comes from the array.
    const emailsNeedingIds = [
      ...followUpsRaw.map((f) => f.recipient_email),
      ...scheduledEmails.filter((s) => !s.matched_contact_id).map((s) => s.recipient_email),
    ];
    const emailToContact = await resolveEmailsToContactIds(service, user.id, emailsNeedingIds);

    const followUps = followUpsRaw.map((f) => {
      const matched =
        (f.recipient_email && emailToContact.get(f.recipient_email.toLowerCase())) || null;
      return { ...f, matched_contact_id: matched };
    });

    const scheduledEnriched = scheduledEmails.map((s) => {
      if (s.matched_contact_id) return s;
      const matched =
        (s.recipient_email && emailToContact.get(s.recipient_email.toLowerCase())) || null;
      return matched ? { ...s, matched_contact_id: matched } : s;
    });

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

    // Thread ids present in this payload — the only ones a calendar link can
    // attach to, so the events read is scoped to them rather than to every
    // event the user has ever synced (CAR-221).
    const threadIds = [
      ...new Set(
        [...emails, ...trashedEmails, ...hiddenEmails]
          .map((e) => e.thread_id)
          .filter((t): t is string => !!t),
      ),
    ];

    const [contactDetails, calendarEvents] = await Promise.all([
      loadContactEmploymentMap(service, user.id, [...idSet]),
      (async () => {
        const out: Array<{
          source_gmail_thread_id: string | null;
          id: number;
          title: string | null;
          start_at: string;
          google_event_id: string;
        }> = [];
        for (const chunk of chunkList(threadIds, 200)) {
          const { data, error } = await service
            .from("calendar_events")
            .select("source_gmail_thread_id, id, title, start_at, google_event_id")
            .eq("user_id", user.id)
            .in("source_gmail_thread_id", chunk);
          if (error) throw error;
          out.push(...(data || []));
        }
        return out;
      })(),
    ]);

    // contactMap is derived from contactDetails rather than read separately
    // (CAR-221). The old read selected the user's WHOLE contacts table with no
    // pagination, so PostgREST's 1000-row cap silently truncated it: a user
    // with 2005 contacts got names for 1000 and every row referencing one of
    // the other 1005 rendered as a bare email address. Both maps now cover
    // exactly the contacts this payload references, which is all any consumer
    // looks up and is immune to the cap by construction.
    const contactMap: Record<number, string> = {};
    for (const [idStr, detail] of Object.entries(contactDetails)) {
      contactMap[Number(idStr)] = detail.name;
    }

    const calendarByThread: Record<string, { id: number; title: string | null; start_at: string; google_event_id: string }> = {};
    for (const ce of calendarEvents) {
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
