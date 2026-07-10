#!/usr/bin/env node
/**
 * One-time migration (CAR-35): move existing contact photos out of Supabase
 * Storage into R2 as 256px WebP thumbnails and repoint contacts.photo_url.
 *
 * Idempotent and resumable — only rows whose photo_url still points at
 * Supabase are touched, so re-running after a partial failure just picks up
 * where it left off. The Supabase objects are left in place until the
 * separate --cleanup pass, so avatars keep working throughout.
 *
 * Usage (from careervine/, with .env.local sourced):
 *   node scripts/migrate-photos-to-r2.mjs --dry-run   # report what would happen
 *   node scripts/migrate-photos-to-r2.mjs             # migrate
 *   node scripts/migrate-photos-to-r2.mjs --cleanup   # AFTER verifying: delete
 *                                                     # every object in the
 *                                                     # contact-photos bucket
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_* (see lib/r2-photos.mjs).
 */

import { createClient } from "@supabase/supabase-js";
import { requireEnv, makeThumb, putPhoto, userPhotoKey, mapConcurrent } from "./lib/r2-photos.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const CLEANUP = process.argv.includes("--cleanup");
const MARKER = "/storage/v1/object/public/contact-photos/";

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

// ── Cleanup mode: wipe the legacy bucket (run only after verification) ──

async function listAllObjects(prefix) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from("contact-photos")
      .list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) out.push(path); // files have ids, folders don't
      else out.push(...(await listAllObjects(path)));
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

if (CLEANUP) {
  const paths = await listAllObjects("");
  console.log(`contact-photos bucket: ${paths.length} objects`);
  if (DRY_RUN) {
    console.log("[dry-run] would delete all of them");
    process.exit(0);
  }
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await supabase.storage.from("contact-photos").remove(batch);
    if (error) throw new Error(`remove batch at ${i}: ${error.message}`);
    console.log(`  deleted ${Math.min(i + 100, paths.length)}/${paths.length}`);
  }
  console.log("Legacy bucket emptied.");
  process.exit(0);
}

// ── Migrate mode ────────────────────────────────────────────────────────

const PAGE = 500;
const rows = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, user_id, photo_url")
    .like("photo_url", `%${MARKER}%`)
    .order("id")
    .range(from, from + PAGE - 1);
  if (error) throw new Error(error.message);
  rows.push(...(data ?? []));
  if (!data || data.length < PAGE) break;
}
console.log(`${rows.length} contacts still on Supabase-storage photos`);
if (DRY_RUN) {
  console.log("[dry-run] stopping before any writes");
  process.exit(0);
}

let done = 0;
let failed = 0;
await mapConcurrent(rows, 8, async (row) => {
  try {
    // Fetch via the public URL (sans cache-bust) — same bytes, no signing dance.
    const res = await fetch(row.photo_url.split("?")[0]);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const thumb = await makeThumb(await res.arrayBuffer());
    const newUrl = await putPhoto(userPhotoKey(row.user_id, row.id, thumb), thumb);
    const { error } = await supabase
      .from("contacts")
      .update({ photo_url: newUrl })
      .eq("id", row.id)
      .like("photo_url", `%${MARKER}%`); // don't clobber a photo replaced mid-run
    if (error) throw new Error(error.message);
    done++;
    if (done % 100 === 0) console.log(`  migrated ${done}/${rows.length}…`);
  } catch (err) {
    failed++;
    console.warn(`  contact ${row.id} failed: ${String(err?.message ?? err)}`);
  }
});

console.log(`Done: ${done} migrated, ${failed} failed.`);
console.log("Spot-check avatars in the app, then run with --cleanup to empty the legacy bucket.");
if (failed > 0) process.exit(1);
