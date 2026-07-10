/**
 * DB-touching import helpers shared by the single-profile extension import
 * route and the pipeline bulk-import route. Extracted from
 * api/contacts/import/route.ts so both paths use one implementation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { makePhotoThumb } from "@/lib/photo-thumb";
import {
  userPhotoKey,
  putPhotoObject,
  r2PublicUrl,
  isUserPhotoUrl,
  deletePhotoByUrl,
} from "@/lib/r2";

interface TagLinkRow {
  tag_id: number;
}

/** Find-or-create the user's tags by name and link them to a contact. */
export async function addTagsToContact(
  supabase: SupabaseClient,
  contactId: number,
  tags: string[],
  userId: string,
) {
  const normalizedTags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (normalizedTags.length === 0) return;

  const { data: existingTags } = await supabase
    .from("tags")
    .select("id, name")
    .eq("user_id", userId);
  const tagMap = new Map<string, { id: number; name: string }>();
  for (const t of (existingTags as { id: number; name: string }[] | null) || []) {
    tagMap.set(t.name.toLowerCase(), t);
  }

  for (const name of normalizedTags) {
    if (!tagMap.has(name)) {
      const { data: newTag } = await supabase
        .from("tags")
        .insert({ name, user_id: userId })
        .select("id, name")
        .single();
      if (newTag) tagMap.set((newTag as { id: number; name: string }).name.toLowerCase(), newTag as { id: number; name: string });
    }
  }

  const tagIds = normalizedTags.map((n) => tagMap.get(n)?.id).filter(Boolean) as number[];
  if (tagIds.length === 0) return;
  const { data: existingLinks } = await supabase
    .from("contact_tags")
    .select("tag_id")
    .eq("contact_id", contactId)
    .in("tag_id", tagIds);
  const linkedSet = new Set(((existingLinks as TagLinkRow[] | null) || []).map((r) => r.tag_id));

  const toInsert = tagIds
    .filter((id) => !linkedSet.has(id))
    .map((tag_id) => ({ contact_id: contactId, tag_id }));
  if (toInsert.length > 0) {
    await supabase.from("contact_tags").insert(toInsert);
  }
}

/**
 * Mirror a LinkedIn CDN profile photo into R2 as a small WebP thumbnail and
 * point the contact at it. SSRF-guarded (media.licdn.com only), 5s fetch
 * timeout, 5MB cap. Throws on failure — callers treat photos as
 * best-effort.
 */
export async function downloadAndStorePhoto(
  supabase: SupabaseClient,
  userId: string,
  contactId: number,
  photoUrl: string,
) {
  // SSRF protection: only allow LinkedIn CDN URLs
  const parsedUrl = new URL(photoUrl);
  if (parsedUrl.hostname !== "media.licdn.com") {
    console.warn(`[import] Rejected non-LinkedIn photo URL hostname: ${parsedUrl.hostname}`);
    return;
  }

  // Fetch the image with a 5-second timeout covering headers + body
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  let imageBuffer: ArrayBuffer;
  try {
    response = await fetch(photoUrl, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      throw new Error(`Photo fetch failed with status ${response.status}`);
    }
    imageBuffer = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }

  // Validate actual payload size (Content-Length can be absent or spoofed)
  if (imageBuffer.byteLength > 5 * 1024 * 1024) {
    console.warn(`[import] Photo too large: ${imageBuffer.byteLength} bytes`);
    return;
  }

  // Cheap sanity check before decoding; sharp is the real validator and
  // throws on anything that isn't a decodable image.
  const contentType = response.headers.get("content-type") || "";
  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (contentType && !ALLOWED_IMAGE_TYPES.some((t) => contentType.startsWith(t))) {
    console.warn(`[import] Rejected non-image content-type: ${contentType}`);
    return;
  }

  const thumb = await makePhotoThumb(imageBuffer);
  const key = userPhotoKey(userId, contactId, thumb);
  await putPhotoObject(key, thumb);
  const newPhotoUrl = r2PublicUrl(key);

  // Swap the pointer, then clean up the previous version (content-hashed
  // keys mean a changed photo is a different object).
  const { data: prevRow } = await supabase
    .from("contacts")
    .select("photo_url")
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();
  const prevUrl = (prevRow as { photo_url: string | null } | null)?.photo_url ?? null;

  const { error: updateError } = await supabase
    .from("contacts")
    .update({ photo_url: newPhotoUrl })
    .eq("id", contactId)
    .eq("user_id", userId);
  if (updateError) throw updateError;

  if (prevUrl && prevUrl !== newPhotoUrl && isUserPhotoUrl(prevUrl)) {
    await deletePhotoByUrl(prevUrl);
  }
}

/** Same validation the extension update path applies to incoming emails. */
export function isValidImportEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 320;
}
