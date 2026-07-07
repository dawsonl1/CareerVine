/**
 * DB-touching import helpers shared by the single-profile extension import
 * route and the pipeline bulk-import route. Extracted from
 * api/contacts/import/route.ts so both paths use one implementation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
 * Download a LinkedIn CDN profile photo into the contact-photos bucket and
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

  // Validate content-type is an image format
  const contentType = response.headers.get("content-type") || "";
  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const resolvedContentType = ALLOWED_IMAGE_TYPES.find((t) => contentType.startsWith(t)) || "image/jpeg";

  const storagePath = `${userId}/${contactId}.jpg`;

  // Upload photo (upsert handles re-imports atomically)
  const { error: uploadError } = await supabase.storage
    .from("contact-photos")
    .upload(storagePath, imageBuffer, {
      contentType: resolvedContentType,
      upsert: true,
    });
  if (uploadError) throw uploadError;

  // Get the public URL with cache-busting timestamp and update the contact record
  const { data: publicUrlData } = supabase.storage
    .from("contact-photos")
    .getPublicUrl(storagePath);
  const photoUrlWithCacheBust = `${publicUrlData.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase
    .from("contacts")
    .update({ photo_url: photoUrlWithCacheBust })
    .eq("id", contactId)
    .eq("user_id", userId);
  if (updateError) throw updateError;
}

/** Same validation the extension update path applies to incoming emails. */
export function isValidImportEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 320;
}
