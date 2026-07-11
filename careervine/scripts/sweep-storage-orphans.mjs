#!/usr/bin/env node
/**
 * One-off storage orphan audit/cleanup (CAR-69). Mirrors the logic of
 * src/lib/storage-sweep.ts for local ops use: lists the attachments and
 * application-files buckets, diffs against the rows that track them
 * (attachments.object_path; pipeline_applications.resume_path /
 * cover_letter_path), and reports or deletes objects with no matching row.
 *
 * Objects created in the last 24h are never touched (uploads land in storage
 * before their DB row is inserted). Idempotent.
 *
 * Usage (from careervine/, with .env.local sourced):
 *   node scripts/sweep-storage-orphans.mjs           # dry-run: report only
 *   node scripts/sweep-storage-orphans.mjs --apply   # delete the orphans
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

async function listAllObjects(bucket) {
  const objects = [];
  const prefixes = [""];
  while (prefixes.length > 0) {
    const prefix = prefixes.shift();
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(prefix, { limit: 100, offset });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      for (const item of data ?? []) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) prefixes.push(path);
        else objects.push({ path, createdAt: item.created_at ?? null, bytes: item.metadata?.size ?? null });
      }
      if (!data || data.length < 100) break;
    }
  }
  return objects;
}

async function fetchPaths(table, columns, extract, filter) {
  const paths = new Set();
  for (let from = 0; ; from += 1000) {
    // Stable total order so LIMIT/OFFSET pages can't skip live rows.
    let q = supabase.from(table).select(columns).order("id").range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} query: ${error.message}`);
    for (const row of data ?? []) for (const p of extract(row)) if (p) paths.add(p);
    if (!data || data.length < 1000) break;
  }
  return paths;
}

const BUCKETS = {
  attachments: () =>
    fetchPaths("attachments", "object_path", (r) => [r.object_path], (q) => q.eq("bucket", "attachments")),
  "application-files": () =>
    fetchPaths("pipeline_applications", "resume_path, cover_letter_path", (r) => [r.resume_path, r.cover_letter_path]),
};

const cutoff = Date.now() - MIN_AGE_MS;

for (const [bucket, fetchLive] of Object.entries(BUCKETS)) {
  // Storage first, DB second — an object uploaded mid-run either isn't seen
  // or its row is already in the snapshot.
  const objects = await listAllObjects(bucket);
  const live = await fetchLive();

  const orphans = [];
  let skippedRecent = 0;
  for (const obj of objects) {
    if (live.has(obj.path)) continue;
    // Fail safe: unknown/unparseable age (NaN) is treated as too-recent to delete.
    const ageTs = obj.createdAt ? new Date(obj.createdAt).getTime() : NaN;
    if (Number.isNaN(ageTs) || ageTs > cutoff) {
      skippedRecent++;
      continue;
    }
    orphans.push(obj);
  }

  console.log(`\n=== ${bucket}: ${objects.length} objects, ${live.size} tracked paths, ${orphans.length} orphans, ${skippedRecent} skipped (<24h old) ===`);
  for (const o of orphans) {
    console.log(`  ${APPLY ? "DELETE" : "orphan"} ${o.path} (${o.bytes ?? "?"} bytes, created ${o.createdAt ?? "?"})`);
  }

  if (APPLY && orphans.length > 0) {
    for (let i = 0; i < orphans.length; i += 100) {
      const batch = orphans.slice(i, i + 100).map((o) => o.path);
      const { error } = await supabase.storage.from(bucket).remove(batch);
      if (error) throw new Error(`remove batch in ${bucket}: ${error.message}`);
    }
    console.log(`  removed ${orphans.length} object(s)`);
  }
}

if (!APPLY) console.log("\nDry run — re-run with --apply to delete.");
