/**
 * Attachment domain queries: Supabase Storage uploads, attachment rows,
 * and the contact/meeting junction links (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db, must } from "./client";

/**
 * Upload a file to Supabase Storage and create an attachment record.
 * Files are stored at: attachments/{userId}/{uuid}_{filename}
 *
 * @param userId - The user's ID (used as folder name for RLS)
 * @param file - The File object to upload
 * @returns Promise<Attachment row> - The created attachment record
 * @throws Error if upload or insert fails
 */
export async function uploadAttachment(userId: string, file: File) {
  const uuid = crypto.randomUUID();
  const objectPath = `${userId}/${uuid}_${file.name}`;

  const { error: uploadError } = await db().storage
    .from("attachments")
    .upload(objectPath, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const { data, error } = await db()
    .from("attachments")
    .insert({
      user_id: userId,
      bucket: "attachments",
      object_path: objectPath,
      file_name: file.name,
      content_type: file.type || null,
      file_size_bytes: file.size,
      is_public: false,
      notes: null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Link an attachment to a contact.
 *
 * @param contactId - The contact's ID
 * @param attachmentId - The attachment's ID
 * @throws Error if insertion fails
 */
export async function addAttachmentToContact(contactId: number, attachmentId: number) {
  const { error } = await db()
    .from("contact_attachments")
    .insert({ contact_id: contactId, attachment_id: attachmentId });
  if (error) throw error;
}

/**
 * Link an attachment to a meeting.
 *
 * @param meetingId - The meeting's ID
 * @param attachmentId - The attachment's ID
 * @throws Error if insertion fails
 */
export async function addAttachmentToMeeting(meetingId: number, attachmentId: number) {
  const { error } = await db()
    .from("meeting_attachments")
    .insert({ meeting_id: meetingId, attachment_id: attachmentId });
  if (error) throw error;
}

/**
 * Get all attachments for a contact.
 *
 * @param contactId - The contact's ID
 * @returns Promise<Attachment[]> - Array of attachment records
 * @throws Error if query fails
 */
export async function getAttachmentsForContact(contactId: number) {
  const { data, error } = await db()
    .from("contact_attachments")
    .select("attachment_id, attachments(*)")
    .eq("contact_id", contactId);
  if (error) throw error;
  return (data || []).map((row) => row.attachments).filter((a): a is NonNullable<typeof a> => a != null);
}

/**
 * Get all attachments for a meeting.
 *
 * @param meetingId - The meeting's ID
 * @returns Promise<Attachment[]> - Array of attachment records
 * @throws Error if query fails
 */
export async function getAttachmentsForMeeting(meetingId: number) {
  const { data, error } = await db()
    .from("meeting_attachments")
    .select("attachment_id, attachments(*)")
    .eq("meeting_id", meetingId);
  if (error) throw error;
  return (data || []).map((row) => row.attachments).filter((a): a is NonNullable<typeof a> => a != null);
}

/**
 * Get a temporary signed URL for downloading/viewing an attachment.
 *
 * @param objectPath - The storage object path (from attachments.object_path)
 * @param expiresIn - Seconds until the URL expires (default 3600 = 1 hour)
 * @returns Promise<string> - Signed URL
 * @throws Error if signing fails
 */
export async function getAttachmentUrl(objectPath: string, expiresIn = 3600) {
  const { data, error } = await db().storage
    .from("attachments")
    .createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Delete an attachment: removes the storage object, the attachment row,
 * and any junction table links.
 *
 * @param attachmentId - The attachment's ID
 * @param objectPath - The storage object path to delete
 * @throws Error if any step fails
 */
export async function deleteAttachment(attachmentId: number, objectPath: string) {
  // Remove from storage
  const { error: storageError } = await db().storage
    .from("attachments")
    .remove([objectPath]);
  if (storageError) throw storageError;

  // Remove junction table links. must(): a silently-failed unlink either
  // orphans junction rows or makes the record delete below fail unexplained.
  must(await db().from("contact_attachments").delete().eq("attachment_id", attachmentId));
  must(await db().from("meeting_attachments").delete().eq("attachment_id", attachmentId));
  must(await db().from("interaction_attachments").delete().eq("attachment_id", attachmentId));

  // Remove attachment record
  const { error } = await db().from("attachments").delete().eq("id", attachmentId);
  if (error) throw error;
}
