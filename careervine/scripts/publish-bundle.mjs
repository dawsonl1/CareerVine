#!/usr/bin/env node
/**
 * Publish (or update) a data bundle via /api/admin/bundles/publish.
 *
 * Deliberately dumb: reads JSON files, chunks to ≤50, POSTs
 * begin → prospects/companies → finalize. All validation, conversion, and
 * versioning happen server-side. Re-running with identical data is a
 * no-op (no version churn, no subscriber fan-out).
 *
 * Usage:
 *   BUNDLE_ADMIN_TOKEN=... node scripts/publish-bundle.mjs \
 *     --slug ib-banks-nyc --name "IB Banks — NYC" \
 *     [--description "..."] \
 *     [--people people.json] [--people-format payload|people_record] \
 *     [--companies companies.json] \
 *     [--url https://careervine.app]   (default http://localhost:3000)
 *
 * people.json: array of BundleProspectPayloadV1 (see src/lib/bundle-payload.ts),
 *   or raw pipeline people-records with --people-format people_record.
 * companies.json: array of { name, linkedin_company_id?, linkedin_url?,
 *   universal_name?, offices: [{ city, state, country? }] }.
 *
 * Photo mirroring (CAR-35): before publishing, every media.licdn.com photo
 * is fetched, thumbnailed, and uploaded once to the shared R2 bundle prefix;
 * the payload then carries the durable R2 URL instead of the expiring
 * LinkedIn one. Successes are cached in <people-file dir>/photo-mirror-cache.json
 * so republishing is incremental. Requires R2_* env (see scripts/lib/r2-photos.mjs);
 * disable with --no-mirror-photos.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mirrorToBundlePhoto, mapConcurrent } from "./lib/r2-photos.mjs";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg("slug");
const name = arg("name");
const description = arg("description");
const peopleFile = arg("people");
const peopleFormat = arg("people-format", "payload");
const companiesFile = arg("companies");
const baseUrl = (arg("url", "http://localhost:3000")).replace(/\/$/, "");
const token = process.env.BUNDLE_ADMIN_TOKEN;

if (!slug) {
  console.error("Missing --slug");
  process.exit(1);
}
if (!token) {
  console.error("BUNDLE_ADMIN_TOKEN is not set");
  process.exit(1);
}
if (!["payload", "people_record"].includes(peopleFormat)) {
  console.error(`Invalid --people-format "${peopleFormat}"`);
  process.exit(1);
}

const endpoint = `${baseUrl}/api/admin/bundles/publish`;

async function call(body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    // Never follow redirects: fetch strips the Authorization header on a
    // cross-origin hop (careervine.app 307s to www.careervine.app), which
    // reads as a baffling 401. Fail loudly with the right URL instead.
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `${endpoint} redirects to ${res.headers.get("location") ?? "?"} — pass that host via --url (auth headers don't survive redirects)`,
    );
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${body.mode} failed (${res.status}): ${json.error ?? "unknown error"}`);
  }
  return json;
}

function chunks(arr, size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const people = peopleFile ? JSON.parse(readFileSync(peopleFile, "utf8")) : [];
const companies = companiesFile ? JSON.parse(readFileSync(companiesFile, "utf8")) : [];
if (!Array.isArray(people) || !Array.isArray(companies)) {
  console.error("--people / --companies files must contain JSON arrays");
  process.exit(1);
}

// ── Photo mirror pass (CAR-35) ──────────────────────────────────────────
// Swaps expiring media.licdn.com photo URLs for durable, shared R2 copies,
// in place, before anything is sent. One mirrored object per distinct
// source URL; the cache file makes republishing incremental.

const mirrorPhotos = !process.argv.includes("--no-mirror-photos");

/** Every mutable {obj, field} slot that may hold a licdn photo URL. */
function photoSlots(person) {
  if (peopleFormat === "payload") return [{ obj: person, field: "photo_url" }];
  return (person.raw_profiles ?? [])
    .filter((p) => p?.data)
    .map((p) => ({ obj: p.data, field: "photo" }));
}

if (mirrorPhotos && people.length > 0) {
  const cachePath = join(dirname(peopleFile), "photo-mirror-cache.json");
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    /* first run */
  }

  const slots = people.flatMap(photoSlots).filter(
    (s) => typeof s.obj[s.field] === "string" && s.obj[s.field].startsWith("https://media.licdn.com/"),
  );
  const distinct = [...new Set(slots.map((s) => s.obj[s.field]))];
  const toMirror = distinct.filter((url) => !cache[url]);
  console.log(
    `Photo mirror: ${distinct.length} distinct licdn URLs (${distinct.length - toMirror.length} cached, ${toMirror.length} to fetch)`,
  );

  let mirrored = 0;
  let failed = 0;
  await mapConcurrent(toMirror, 8, async (url) => {
    try {
      cache[url] = await mirrorToBundlePhoto(url);
      mirrored++;
      if (mirrored % 100 === 0) {
        console.log(`  mirrored ${mirrored}/${toMirror.length}…`);
        writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      }
    } catch (err) {
      failed++;
      console.warn(`  photo failed (${String(err?.message ?? err)}): ${url.slice(0, 80)}…`);
    }
  });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  let swapped = 0;
  let dropped = 0;
  for (const s of slots) {
    const r2Url = cache[s.obj[s.field]];
    if (r2Url) {
      s.obj[s.field] = r2Url;
      swapped++;
    } else {
      // licdn URLs expire — publishing one would strand subscribers with a
      // broken image. No photo beats a dead photo.
      s.obj[s.field] = null;
      dropped++;
    }
  }
  console.log(`Photo mirror: ${mirrored} newly mirrored, ${failed} failed, ${swapped} slots swapped, ${dropped} dropped`);
}

console.log(`Publishing "${slug}" to ${baseUrl} (${people.length} prospects, ${companies.length} companies)`);

const { bundleId, stagingVersion } = await call({ mode: "begin", slug, name, description });
console.log(`Claimed publish lock: bundle #${bundleId}, staging v${stagingVersion}`);

try {
  let done = 0;
  for (const chunk of chunks(people)) {
    const r = await call({ mode: "prospects", slug, stagingVersion, people: chunk, peopleFormat });
    done += chunk.length;
    console.log(
      `  prospects ${done}/${people.length}: +${r.added} added, ~${r.updated} updated, =${r.unchanged} unchanged, ↺${r.readded} readded`,
    );
  }

  done = 0;
  for (const chunk of chunks(companies)) {
    const r = await call({ mode: "companies", slug, stagingVersion, companies: chunk });
    done += chunk.length;
    console.log(`  companies ${done}/${companies.length}: ${r.companies} companies, ${r.offices} offices`);
  }

  const result = await call({ mode: "finalize", slug, stagingVersion });
  if (result.published) {
    console.log(
      `Published v${result.version}: ${result.prospectCount} prospects, ${result.companyCount} companies, ${result.removed} removed. Subscribers will sync shortly.`,
    );
  } else {
    console.log(
      `No changes vs v${result.version} — version not bumped, no subscriber fan-out. Counts refreshed (${result.prospectCount} prospects, ${result.companyCount} companies).`,
    );
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  console.error("Aborting publish (releasing lock)…");
  await call({ mode: "abort", slug, stagingVersion }).catch(() => {});
  process.exit(1);
}
