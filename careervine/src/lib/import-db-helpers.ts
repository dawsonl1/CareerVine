/**
 * DB-touching import helpers shared by the single-profile extension import
 * route and the pipeline bulk-import route. Extracted from
 * api/contacts/import/route.ts so both paths use one implementation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkList } from "@/lib/data/postgrest";
import { makePhotoThumb } from "@/lib/photo-thumb";
import {
  userPhotoKey,
  putPhotoObject,
  r2PublicUrl,
  isUserPhotoUrl,
  deletePhotoByUrl,
} from "@/lib/r2";

/**
 * Batched additive tagging (CAR-47): find-or-create the user's tags and
 * link them to many contacts in a fixed number of queries (one tag select,
 * one missing-tag insert, one link select, one link insert) instead of
 * 2–4 queries per contact. Bulk writes degrade to per-row on failure so
 * one bad row can't sink the rest.
 */
export async function addTagsToContacts(
  supabase: SupabaseClient,
  userId: string,
  tagsByContact: Map<number, string[]>,
) {
  const normalizedByContact = new Map<number, string[]>();
  const allNames = new Set<string>();
  for (const [contactId, tags] of tagsByContact) {
    const normalized = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (normalized.length === 0) continue;
    normalizedByContact.set(contactId, normalized);
    for (const n of normalized) allNames.add(n);
  }
  if (normalizedByContact.size === 0) return;

  const { data: existingTags } = await supabase
    .from("tags")
    .select("id, name")
    .eq("user_id", userId);
  const tagMap = new Map<string, { id: number; name: string }>();
  for (const t of (existingTags as { id: number; name: string }[] | null) || []) {
    tagMap.set(t.name.toLowerCase(), t);
  }

  const missing = [...allNames].filter((n) => !tagMap.has(n));
  if (missing.length > 0) {
    const { data: created, error } = await supabase
      .from("tags")
      .insert(missing.map((name) => ({ name, user_id: userId })))
      .select("id, name");
    if (!error) {
      for (const t of (created as { id: number; name: string }[] | null) || []) {
        tagMap.set(t.name.toLowerCase(), t);
      }
    } else {
      for (const name of missing) {
        const { data: newTag } = await supabase
          .from("tags")
          .insert({ name, user_id: userId })
          .select("id, name")
          .single();
        if (newTag) tagMap.set((newTag as { id: number; name: string }).name.toLowerCase(), newTag as { id: number; name: string });
      }
    }
  }

  const contactIds = [...normalizedByContact.keys()];
  const tagIds = [...new Set([...allNames].map((n) => tagMap.get(n)?.id).filter(Boolean))] as number[];
  if (tagIds.length === 0) return;

  const linkedSet = new Set<string>();
  for (const idChunk of chunkList(contactIds)) {
    const { data: existingLinks } = await supabase
      .from("contact_tags")
      .select("contact_id, tag_id")
      .in("contact_id", idChunk)
      .in("tag_id", tagIds);
    for (const r of (existingLinks as Array<{ contact_id: number; tag_id: number }> | null) || []) {
      linkedSet.add(`${r.contact_id}:${r.tag_id}`);
    }
  }

  const toInsert: Array<{ contact_id: number; tag_id: number }> = [];
  for (const [contactId, names] of normalizedByContact) {
    for (const name of names) {
      const tag = tagMap.get(name);
      if (tag && !linkedSet.has(`${contactId}:${tag.id}`)) {
        toInsert.push({ contact_id: contactId, tag_id: tag.id });
      }
    }
  }
  if (toInsert.length === 0) return;
  const { error: linkError } = await supabase.from("contact_tags").insert(toInsert);
  if (linkError) {
    // Same silent-per-row semantics the single-contact path always had.
    for (const row of toInsert) await supabase.from("contact_tags").insert(row);
  }
}

/** Find-or-create the user's tags by name and link them to a contact. */
export async function addTagsToContact(
  supabase: SupabaseClient,
  contactId: number,
  tags: string[],
  userId: string,
) {
  await addTagsToContacts(supabase, userId, new Map([[contactId, tags]]));
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
