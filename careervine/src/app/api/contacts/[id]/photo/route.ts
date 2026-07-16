/**
 * POST/DELETE /api/contacts/[id]/photo — contact photo upload & removal (CAR-35).
 *
 * Photos live in R2 and R2 credentials are server-only, so the browser can't
 * write storage directly the way it could with Supabase. Both handlers run on
 * the user's session client (RLS enforces ownership; we also filter by
 * user_id explicitly). Uploads are thumbnailed to a 256px WebP before
 * storage; keys are content-hashed, so a replaced photo is a new object and
 * the old one is deleted best-effort.
 *
 * DELETE also handles legacy Supabase-storage photos (pre-migration rows)
 * so removal keeps working during the transition window.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { validateContactPhotoFile } from "@/lib/contact-photo";
import { makePhotoThumb } from "@/lib/photo-thumb";
import { userPhotoKey, putPhotoObject, r2PublicUrl } from "@/lib/r2";
import { cleanupContactPhoto } from "@/lib/contact-photo-cleanup";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 30;

async function getOwnedContactPhoto(
  supabase: SupabaseClient,
  userId: string,
  contactId: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, photo_url")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ApiError("Failed to load contact", 500);
  if (!data) throw new ApiError("Contact not found", 404);
  return (data as { photo_url: string | null }).photo_url;
}

export const POST = withApiHandler({
  handler: async ({ request, user, supabase, params }) => {
    const contactId = Number(params.id);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      throw new ApiError("Invalid contact id", 400);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError("Expected multipart form data", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("Missing file", 400);
    const validationError = validateContactPhotoFile(file);
    if (validationError) throw new ApiError(validationError, 400);

    const prevUrl = await getOwnedContactPhoto(supabase, user.id, contactId);

    let thumb: Buffer;
    try {
      thumb = await makePhotoThumb(await file.arrayBuffer());
    } catch {
      throw new ApiError("That file doesn't look like a valid image.", 400);
    }

    const key = userPhotoKey(user.id, contactId, thumb);
    await putPhotoObject(key, thumb);
    const photoUrl = r2PublicUrl(key);

    const { error: updateError } = await supabase
      .from("contacts")
      .update({ photo_url: photoUrl })
      .eq("id", contactId)
      .eq("user_id", user.id);
    if (updateError) throw new ApiError("Failed to save photo", 500);

    if (prevUrl !== photoUrl) {
      await cleanupContactPhoto(supabase, user.id, contactId, prevUrl);
    }

    return { photoUrl };
  },
});

export const DELETE = withApiHandler({
  handler: async ({ user, supabase, params }) => {
    const contactId = Number(params.id);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      throw new ApiError("Invalid contact id", 400);
    }

    const prevUrl = await getOwnedContactPhoto(supabase, user.id, contactId);
    if (prevUrl) {
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ photo_url: null })
        .eq("id", contactId)
        .eq("user_id", user.id);
      if (updateError) throw new ApiError("Failed to remove photo", 500);
      await cleanupContactPhoto(supabase, user.id, contactId, prevUrl);
    }

    return { photoUrl: null };
  },
});
