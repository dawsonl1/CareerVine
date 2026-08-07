/**
 * Meeting domain queries: meetings CRUD, meeting_contacts attendee links,
 * and transcript segments (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db, must } from "./client";
import { chunkedPaginated, paginateAll } from "./postgrest";
import type { Database } from "@/lib/database.types";
import { activateContacts } from "./contacts";
import { deleteAttachment } from "./attachments";

/**
 * Fetch all meetings for a user with attendee information
 *
 * @param userId - The user's ID
 * @returns Promise<Meeting[]> - Array of meetings with contact attendees
 * @throws Error if query fails
 */
export async function getMeetings(userId: string) {
  const { data, error } = await db()
    .from("meetings")
    .select(`
      *,
      meeting_contacts(
        *,
        contacts(*)
      )
    `)
    .eq("user_id", userId)
    .order("meeting_date", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data;
}

/**
 * Fetch meetings for a specific contact via the meeting_contacts join
 *
 * @param contactId - The contact's ID
 * @returns Promise<Meeting[]> - Array of meetings sorted by date (most recent first)
 * @throws Error if query fails
 */
export async function getMeetingsForContact(contactId: number) {
  const { data, error } = await db()
    .from("meeting_contacts")
    .select(`
      meetings(
        id,
        meeting_date,
        meeting_type,
        meeting_type_detail,
        title,
        notes,
        private_notes,
        calendar_description,
        transcript
      )
    `)
    .eq("contact_id", contactId);

  if (error) throw error;
  // meeting_contacts → meetings is a to-one embed; the typed client returns one meeting (or null) per row.
  const meetings = (data || [])
    .map((row) => row.meetings)
    .filter((m): m is NonNullable<typeof m> => m != null);
  meetings.sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime());
  return meetings;
}

/**
 * Create a new meeting
 *
 * @param meeting - Meeting data matching the meetings table schema (without id)
 * @returns Promise<Meeting> - The created meeting with generated id
 * @throws Error if creation fails
 */
export async function createMeeting(
  meeting: Database["public"]["Tables"]["meetings"]["Insert"]
) {
  const { data, error } = await db()
    .from("meetings")
    .insert(meeting)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update an existing meeting
 *
 * @param id - The meeting's ID
 * @param updates - Partial meeting data to update
 * @returns Promise<Meeting> - The updated meeting
 * @throws Error if update fails
 */
export async function updateMeeting(
  id: number,
  updates: Database["public"]["Tables"]["meetings"]["Update"]
) {
  // cas-checked: the only filter is the primary key, which is never a
  // written column, so this is a plain update-and-return rather than a
  // compare-and-set and the .select() readback is sound.
  const { data, error } = await db()
    .from("meetings")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Attachment ids referenced by this meeting (meeting_attachments links plus
 * the transcript recording) that no OTHER record still points at. Shared
 * attachments — linked to a contact, an interaction, or another meeting —
 * must survive the meeting's deletion.
 */
async function exclusiveAttachmentIds(meetingId: number): Promise<number[]> {
  const meeting = must(
    await db()
      .from("meetings")
      .select("transcript_attachment_id")
      .eq("id", meetingId)
      .maybeSingle(),
  );
  const links = must(
    await db()
      .from("meeting_attachments")
      .select("attachment_id")
      .eq("meeting_id", meetingId),
  );

  const candidates = new Set<number>((links ?? []).map((r) => r.attachment_id));
  if (meeting?.transcript_attachment_id != null) {
    candidates.add(meeting.transcript_attachment_id);
  }
  if (candidates.size === 0) return [];

  const ids = [...candidates];
  const shared = new Set<number>();

  const contactRefs = must(
    await db().from("contact_attachments").select("attachment_id").in("attachment_id", ids),
  );
  for (const r of contactRefs ?? []) shared.add(r.attachment_id);

  const interactionRefs = must(
    await db().from("interaction_attachments").select("attachment_id").in("attachment_id", ids),
  );
  for (const r of interactionRefs ?? []) shared.add(r.attachment_id);

  const otherMeetingLinks = must(
    await db()
      .from("meeting_attachments")
      .select("attachment_id")
      .in("attachment_id", ids)
      .neq("meeting_id", meetingId),
  );
  for (const r of otherMeetingLinks ?? []) shared.add(r.attachment_id);

  const otherTranscripts = must(
    await db()
      .from("meetings")
      .select("transcript_attachment_id")
      .in("transcript_attachment_id", ids)
      .neq("id", meetingId),
  );
  for (const r of otherTranscripts ?? []) {
    if (r.transcript_attachment_id != null) shared.add(r.transcript_attachment_id);
  }

  return ids.filter((attachmentId) => !shared.has(attachmentId));
}

/**
 * Delete a meeting along with its meeting_contacts rows and any attachments
 * that belong exclusively to it (CAR-156 / R4.7). Cascade deletes only remove
 * junction rows — without this, the attachment rows and storage objects
 * (including raw meeting audio, the largest PII objects we hold) survive
 * forever: the storage sweep can't reclaim an object whose row still exists.
 *
 * @param id - The meeting's ID
 * @throws Error if operation fails
 */
export async function deleteMeeting(id: number) {
  // Reclaim exclusively-owned attachments before the meeting row (and its
  // junction rows) disappear. deleteAttachment removes storage + row; the
  // junction rows cascade and meetings.transcript_attachment_id is
  // ON DELETE SET NULL, so ordering is safe.
  const reclaimable = await exclusiveAttachmentIds(id);
  if (reclaimable.length > 0) {
    const rows = must(
      await db().from("attachments").select("id, object_path").in("id", reclaimable),
    );
    for (const row of rows ?? []) {
      await deleteAttachment(row.id, row.object_path);
    }
  }

  // Delete associated contacts first
  const { error: mcError } = await db()
    .from("meeting_contacts")
    .delete()
    .eq("meeting_id", id);
  if (mcError) throw mcError;

  const { error } = await db()
    .from("meetings")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Replace all contacts for a meeting (delete existing, insert new)
 *
 * @param meetingId - The meeting's ID
 * @param contactIds - New array of contact IDs
 * @throws Error if operation fails
 */
export async function replaceContactsForMeeting(meetingId: number, contactIds: number[]) {
  // Delete existing links
  const { error: delError } = await db()
    .from("meeting_contacts")
    .delete()
    .eq("meeting_id", meetingId);
  if (delError) throw delError;

  // Insert new links
  if (contactIds.length > 0) {
    const rows = contactIds.map((contact_id) => ({ meeting_id: meetingId, contact_id }));
    const { error: insError } = await db().from("meeting_contacts").insert(rows);
    if (insError) throw insError;
    await activateContacts(contactIds);
  }
}

/**
 * Link one or more contacts to a meeting via the meeting_contacts join table
 *
 * @param meetingId - The meeting's ID
 * @param contactIds - Array of contact IDs to link
 * @throws Error if insertion fails
 */
export async function addContactsToMeeting(meetingId: number, contactIds: number[]) {
  if (contactIds.length === 0) return;
  const rows = contactIds.map((contact_id) => ({ meeting_id: meetingId, contact_id }));
  const { error } = await db().from("meeting_contacts").insert(rows);
  if (error) throw error;
  await activateContacts(contactIds);
}

// ── Transcript Segments ──

/**
 * Atomically replace transcript segments for a meeting.
 * Uses a Postgres function to delete+insert in a single transaction,
 * preventing data loss if the insert fails.
 */
export async function createTranscriptSegments(
  meetingId: number,
  segments: { speaker_label: string; contact_id?: number | null; started_at?: number | null; ended_at?: number | null; content: string }[],
) {
  if (segments.length === 0) {
    // must(): a silently-failed wipe would leave stale segments behind
    // while the caller believes the transcript is empty.
    must(await db().from("transcript_segments").delete().eq("meeting_id", meetingId));
    return [];
  }

  const rows = segments.map((s, i) => ({
    ordinal: i,
    speaker_label: s.speaker_label,
    contact_id: s.contact_id ?? null,
    started_at: s.started_at ?? null,
    ended_at: s.ended_at ?? null,
    content: s.content,
  }));

  const { error } = await db().rpc("replace_transcript_segments", {
    p_meeting_id: meetingId,
    p_segments: rows,
  });
  if (error) throw error;

  // Return the newly inserted segments
  return getTranscriptSegments(meetingId);
}

/**
 * Get all transcript segments for a meeting, ordered by position.
 */
export async function getTranscriptSegments(meetingId: number) {
  // Paginated (CAR-223): one row per Deepgram utterance, so a 45-60 minute
  // recording routinely passes PostgREST's 1000-row cap. Unpaginated, the
  // transcript simply stopped mid-conversation with nothing to say it had.
  return paginateAll(async (from, to) =>
    must(
      await db()
        .from("transcript_segments")
        .select("*, contacts:contact_id(id, name)")
        .eq("meeting_id", meetingId)
        .order("ordinal")
        .range(from, to),
    ),
  );
}

/**
 * Transcript segments for MANY meetings in ONE batched read (CAR-229).
 *
 * Third of the per-meeting reads the activity timeline fired inside a
 * `Promise.all(meetings.map(...))`. Anything iterating meetings calls this; the
 * singular function stays for the speaker-resolver reload, which refreshes one
 * meeting after a write.
 *
 * chunkedPaginated for the same reason getTranscriptSegments paginates: one
 * row per utterance, so a single meeting routinely passes PostgREST's 1000-row
 * cap and a whole chunk of meetings certainly does.
 *
 * @param meetingIds - Meeting ids to fetch for; an empty list issues no query
 * @returns Promise<Record<meetingId, TranscriptSegment[]>> - meetings with no
 *   segments are absent from the map
 */
export async function getTranscriptSegmentsForMeetings(meetingIds: number[]) {
  const rows = await chunkedPaginated(meetingIds, async (chunk, from, to) =>
    must(
      await db()
        .from("transcript_segments")
        .select("*, contacts:contact_id(id, name)")
        .in("meeting_id", chunk)
        // meeting_id leads for a stable total order across range windows;
        // ordinal is the within-meeting order getTranscriptSegments returns.
        .order("meeting_id", { ascending: true })
        .order("ordinal", { ascending: true })
        .range(from, to),
    ),
  );

  const byMeeting: Record<number, typeof rows> = {};
  for (const row of rows) (byMeeting[row.meeting_id] ??= []).push(row);
  return byMeeting;
}

// ── Attendee identity ────────────────────────────────────────────────────
//
// The activity and calendar timelines both label attendees, and both used to
// do it by pulling the user's ENTIRE contact list — ~2,000 rows dragging every
// joined email, phone, company, school and tag — to read one field off it. On
// a real network that single read was the slowest request on either page. The
// two lookups below replace it with a read bounded by the attendees actually
// on screen (CAR-229).
//
// They live in the meeting domain because their only consumers are the meeting
// and calendar attendee surfaces, and because contact_emails fans out per
// contact, both go through chunkedPaginated rather than chunked.

/**
 * Which network statuses an attendee lookup resolves. Mirrors getContacts'
 * default (bench excluded), because these lookups REPLACED a getContacts call
 * on both timelines: widening this would start labelling attendees that neither
 * page has ever labelled, and would flip /calendar's "With contacts" filter for
 * events whose only known attendee is benched.
 */
const ATTENDEE_NETWORK_STATUSES = ["active", "prospect"] as const;

/**
 * First email address of each of `contactIds`, keyed by contact id.
 *
 * "First" reproduces exactly what the activity timeline read off getContacts —
 * element 0 of the embedded contact_emails array — so RSVP badges keep matching
 * the same single address. Ordering by id states that order rather than
 * inheriting PostgREST's embed order by accident.
 *
 * @param userId - The user's ID; scopes through a contacts!inner join
 * @param contactIds - Contact ids to resolve; an empty list issues no query
 */
export async function getFirstEmailByContactId(
  userId: string,
  contactIds: number[],
): Promise<Map<number, string>> {
  const rows = await chunkedPaginated([...new Set(contactIds)], async (chunk, from, to) =>
    must(
      await db()
        .from("contact_emails")
        .select("contact_id, email, contacts!inner(user_id, network_status)")
        .in("contact_id", chunk)
        .eq("contacts.user_id", userId)
        .in("contacts.network_status", [...ATTENDEE_NETWORK_STATUSES])
        .order("contact_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  );

  const first = new Map<number, string>();
  for (const row of rows) {
    if (!row.email || first.has(row.contact_id)) continue;
    first.set(row.contact_id, row.email);
  }
  return first;
}

/**
 * Contact id + name for each of `emails`, keyed by the LOWERCASED address.
 *
 * Addresses are lowercased on the way in as well as out: contact_emails.email
 * is stored lower(trim())-normalized (one-time backfill plus a trigger, CAR-153
 * migration 20260717020000), but the calendar attendee addresses this is called
 * with come straight from Google and are not.
 *
 * @param userId - The user's ID; scopes through a contacts!inner join
 * @param emails - Addresses to resolve; an empty list issues no query
 */
export async function getContactsByEmail(
  userId: string,
  emails: string[],
): Promise<Map<string, { id: number; name: string }>> {
  const wanted = [...new Set(emails.map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean))];

  const rows = await chunkedPaginated<
    { email: string | null; contacts: { id: number; name: string } | null },
    string
  >(wanted, async (chunk, from, to) =>
    must(
      await db()
        .from("contact_emails")
        .select("email, contacts!inner(id, name, user_id, network_status)")
        .in("email", chunk)
        .eq("contacts.user_id", userId)
        .in("contacts.network_status", [...ATTENDEE_NETWORK_STATUSES])
        .order("id", { ascending: true })
        .range(from, to),
    ),
  );

  const byEmail = new Map<string, { id: number; name: string }>();
  for (const row of rows) {
    if (!row.email || !row.contacts) continue;
    byEmail.set(row.email.toLowerCase(), { id: row.contacts.id, name: row.contacts.name });
  }
  return byEmail;
}

/**
 * Bulk-update contact_id for all segments matching a speaker label in a meeting.
 */
export async function updateSpeakerContact(
  meetingId: number,
  speakerLabel: string,
  contactId: number | null,
) {
  const { error } = await db()
    .from("transcript_segments")
    .update({ contact_id: contactId })
    .eq("meeting_id", meetingId)
    .eq("speaker_label", speakerLabel);
  if (error) throw error;
}

/**
 * Delete all transcript segments for a meeting.
 */
export async function deleteTranscriptSegments(meetingId: number) {
  const { error } = await db()
    .from("transcript_segments")
    .delete()
    .eq("meeting_id", meetingId);
  if (error) throw error;
}
