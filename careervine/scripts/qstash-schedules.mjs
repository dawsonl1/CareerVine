#!/usr/bin/env node
/**
 * QStash schedule source-of-truth + audit/reconcile (CAR-107).
 *
 * The six CareerVine cron schedules used to live only in the Upstash console.
 * This file is the repo record: the SCHEDULES array below is authoritative,
 * and the script diffs it against what's actually live so drift is visible and
 * the schedules can be recreated if the account is ever lost.
 *
 * Usage:
 *   node scripts/qstash-schedules.mjs list   # (default) read-only diff; exits 1 on drift
 *   node scripts/qstash-schedules.mjs sync   # create missing + fix drifted (never deletes extras)
 *
 * Env: QSTASH_TOKEN (in secrets.zsh). The API host is region-pinned — the
 * generic qstash.upstash.io geo-routes and rejects this account. Destinations
 * use the www host on purpose: the apex 307-redirects and undici strips the
 * signature header on the cross-origin hop (learned rule 29).
 */

const QSTASH_API = "https://qstash-us-east-1.upstash.io/v2";
const DEST_HOST = "https://www.careervine.app";

/**
 * Authoritative schedule set. Seeded from the live state on 2026-07-12 so a
 * fresh `list` reports everything in sync. To change a cadence: edit here, then
 * run `sync`. `body` is always {} — the cron routes read req.text() but act on
 * their own logic, not the payload.
 */
const SCHEDULES = [
  { name: "send-follow-ups", path: "/api/cron/send-follow-ups", cron: "*/10 * * * *", retries: 3 },
  { name: "send-scheduled-emails", path: "/api/cron/send-scheduled-emails", cron: "*/15 * * * *", retries: 3 },
  { name: "sync-bundles", path: "/api/cron/sync-bundles", cron: "0 12 * * *", retries: 3 },
  { name: "scrape-refresh", path: "/api/cron/scrape-refresh", cron: "0 9 * * *", retries: 3 },
  { name: "discovery", path: "/api/cron/discovery", cron: "0 10 * * 1", retries: 3 },
  { name: "storage-sweep", path: "/api/cron/storage-sweep", cron: "0 10 * * *", retries: 3 },
];

const token = process.env.QSTASH_TOKEN;
if (!token) {
  console.error("QSTASH_TOKEN is not set");
  process.exit(1);
}

const mode = process.argv[2] ?? "list";
if (!["list", "sync"].includes(mode)) {
  console.error(`Unknown mode "${mode}" — use "list" or "sync"`);
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };
const destOf = (path) => `${DEST_HOST}${path}`;

async function qstash(method, path, headers = {}) {
  const res = await fetch(`${QSTASH_API}${path}`, { method, headers: { ...auth, ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Map live schedules by their destination URL. */
async function fetchLive() {
  const live = await qstash("GET", "/schedules");
  const byDest = new Map();
  for (const s of live) byDest.set(s.destination, s);
  return byDest;
}

async function createSchedule(s) {
  // QStash appends the raw destination URL to the path (documented curl form).
  const out = await qstash("POST", `/schedules/${destOf(s.path)}`, {
    "Upstash-Cron": s.cron,
    "Upstash-Retries": String(s.retries),
    "Content-Type": "application/json",
  });
  return out?.scheduleId;
}

async function deleteSchedule(scheduleId) {
  await qstash("DELETE", `/schedules/${scheduleId}`);
}

/** Compare one declared schedule against live; returns a status descriptor. */
function diff(decl, live) {
  if (!live) return { status: "missing" };
  const reasons = [];
  if (live.cron !== decl.cron) reasons.push(`cron ${live.cron} → ${decl.cron}`);
  if ((live.retries ?? 0) !== decl.retries) reasons.push(`retries ${live.retries} → ${decl.retries}`);
  return reasons.length ? { status: "drift", reasons, scheduleId: live.scheduleId } : { status: "ok", scheduleId: live.scheduleId };
}

async function main() {
  const byDest = await fetchLive();
  const declaredDests = new Set(SCHEDULES.map((s) => destOf(s.path)));

  const rows = SCHEDULES.map((s) => ({ s, d: diff(s, byDest.get(destOf(s.path))) }));
  const extras = [...byDest.values()].filter((l) => !declaredDests.has(l.destination));

  const icon = { ok: "✓", drift: "⚠", missing: "✗" };
  console.log(`QStash schedules (${mode}) — ${QSTASH_API}\n`);
  for (const { s, d } of rows) {
    const detail = d.status === "drift" ? `  [${d.reasons.join("; ")}]` : d.status === "missing" ? "  [not live]" : "";
    console.log(`  ${icon[d.status]} ${s.name.padEnd(22)} ${s.cron.padEnd(14)} → ${s.path}${detail}`);
  }
  for (const l of extras) console.log(`  ? undeclared            ${String(l.cron).padEnd(14)} → ${l.destination} (live but not in SCHEDULES)`);

  const drifted = rows.filter((r) => r.d.status === "drift");
  const missing = rows.filter((r) => r.d.status === "missing");

  if (mode === "list") {
    console.log(
      `\n${rows.filter((r) => r.d.status === "ok").length} in sync, ${drifted.length} drifted, ${missing.length} missing, ${extras.length} undeclared`,
    );
    if (extras.length) console.log("Undeclared schedules are left untouched — remove them in the console or add them to SCHEDULES.");
    if (drifted.length || missing.length) process.exitCode = 1; // gate on drift
    return;
  }

  // sync: create missing, fix drifted (create-then-delete so there's no gap).
  if (!drifted.length && !missing.length) {
    console.log("\nNothing to do — all declared schedules are in sync.");
    return;
  }
  console.log(`\nApplying: ${missing.length} to create, ${drifted.length} to recreate. (Undeclared extras are never deleted.)`);
  for (const { s } of missing) {
    const id = await createSchedule(s);
    console.log(`  + created ${s.name} (${id})`);
  }
  for (const { s, d } of drifted) {
    const id = await createSchedule(s); // create new before deleting old — never leave the destination unscheduled
    await deleteSchedule(d.scheduleId);
    console.log(`  ~ recreated ${s.name} (${d.scheduleId} → ${id})`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
