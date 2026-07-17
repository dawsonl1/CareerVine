/**
 * Meeting domain queries: meetings CRUD, meeting_contacts attendee links,
 * and transcript segments (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db, must } from "./client";
import type { Database } from "@/lib/database.types";
import { activateContacts } from "./contacts";

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
 * Delete a meeting and its associated meeting_contacts rows
 *
 * @param id - The meeting's ID
 * @throws Error if operation fails
 */
export async function deleteMeeting(id: number) {
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
  const { data, error } = await db()
    .from("transcript_segments")
    .select("*, contacts:contact_id(id, name)")
    .eq("meeting_id", meetingId)
    .order("ordinal");
  if (error) throw error;
  return data;
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
