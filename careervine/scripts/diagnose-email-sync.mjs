#!/usr/bin/env node
/**
 * Read-only diagnostic for Gmail sync ("my emails aren't syncing").
 *
 * Run from the careervine/ directory:
 *   node --env-file=.env.local scripts/diagnose-email-sync.mjs
 *
 * What it does (READ-ONLY — writes nothing to the database):
 *   1. Reads the gmail_connections row: does a connection exist? when did
 *      the last sync complete? is the stored access token expired?
 *   2. Probes Google directly: is the access token still valid, and —
 *      the critical check — can the refresh token still mint new access
 *      tokens? A dead refresh token (invalid_grant) makes every sync
 *      silently return "Synced 0 emails" because per-contact errors are
 *      swallowed in syncAllContactEmails.
 *   3. Measures the sync workload: how many contacts have email addresses
 *      (the sync loop iterates every one of them, serially, inside a
 *      single Vercel invocation) and how much of that is bulk-imported
 *      prospects/bench that have no email history to sync.
 *   4. Checks the email_messages cache: total rows and the newest message
 *      date, i.e. when sync last actually landed anything.
 *
 * Token values are never printed.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run from careervine/ with: node --env-file=.env.local scripts/diagnose-email-sync.mjs");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

function fmtAge(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min ago`;
  if (h < 48) return `${h.toFixed(1)} hours ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

async function count(table, selectStr, build) {
  let q = supabase.from(table).select(selectStr, { count: "exact", head: true });
  if (build) q = build(q);
  const { count: n, error } = await q;
  if (error) return `error: ${error.message}`;
  return n;
}

const findings = [];

// ── 1. Connection state ──────────────────────────────────────────────
const { data: conns, error: connErr } = await supabase
  .from("gmail_connections")
  .select("user_id, gmail_address, created_at, updated_at, last_gmail_sync_at, token_expires_at, access_token, refresh_token");

if (connErr) {
  console.error("Could not read gmail_connections:", connErr.message);
  process.exit(1);
}

if (!conns || conns.length === 0) {
  console.log("── Connection ──");
  console.log("NO gmail_connections row exists.");
  findings.push(
    "ROOT CAUSE CANDIDATE: the Gmail connection row is gone. The app deletes it when a token refresh fails with invalid_grant (revoked/expired refresh token). Reconnect Gmail in Settings → Integrations. If this recurs every ~7 days, the Google OAuth consent screen is in 'Testing' publishing status — publish the app in Google Cloud Console to get non-expiring refresh tokens."
  );
} else {
  for (const conn of conns) {
    console.log("── Connection ──");
    console.log(`Gmail address:      ${conn.gmail_address}`);
    console.log(`Connected since:    ${conn.created_at} (${fmtAge(conn.created_at)})`);
    console.log(`Last sync finished: ${conn.last_gmail_sync_at ?? "never"} (${fmtAge(conn.last_gmail_sync_at)})`);
    const expMs = new Date(conn.token_expires_at).getTime();
    console.log(`Access token:       ${expMs < Date.now() ? "EXPIRED (normal — refreshed on demand)" : `valid for ${Math.round((expMs - Date.now()) / 60_000)} more min`}`);

    // ── 2. Google-side probes (no values printed) ────────────────────
    console.log("\n── Google token health ──");
    try {
      const ti = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(conn.access_token)}`
      );
      const tiBody = await ti.json();
      if (ti.ok) {
        console.log(`Access token check: VALID (scopes: ${tiBody.scope ?? "?"})`);
      } else {
        console.log(`Access token check: invalid/expired (${tiBody.error_description ?? tiBody.error ?? ti.status}) — only a problem if the refresh check below also fails`);
      }
    } catch (e) {
      console.log(`Access token check: network error (${e.message})`);
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (clientId && clientSecret) {
      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: conn.refresh_token,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        const body = await res.json();
        if (res.ok && body.access_token) {
          console.log("Refresh token check: HEALTHY — Google minted a fresh access token. Auth is NOT the problem.");
        } else {
          console.log(`Refresh token check: FAILED (${body.error ?? res.status}: ${body.error_description ?? ""})`);
          if (body.error === "invalid_grant") {
            findings.push(
              "ROOT CAUSE CONFIRMED: the Google refresh token is dead (invalid_grant). Every sync fails per-contact, the errors are swallowed, and the UI reports 'Synced 0 emails' as if it succeeded. Fix: disconnect + reconnect Gmail in Settings → Integrations. If the Google Cloud OAuth consent screen is in 'Testing' status, refresh tokens expire every 7 days — publish the app to stop the recurrence."
            );
          } else {
            findings.push(`Refresh token probe failed with '${body.error}': investigate GOOGLE_CLIENT_ID/SECRET match between .env.local and the Vercel deployment.`);
          }
        }
      } catch (e) {
        console.log(`Refresh token check: network error (${e.message})`);
      }
    } else {
      console.log("Refresh token check: skipped (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not in env file)");
    }

    // ── 3. Sync workload ─────────────────────────────────────────────
    const uid = conn.user_id;
    console.log("\n── Sync workload ──");
    const totalContacts = await count("contacts", "id", (q) => q.eq("user_id", uid));
    const loopSize = await count("contacts", "id, contact_emails!inner(id)", (q) => q.eq("user_id", uid));
    const byStatus = {};
    for (const s of ["active", "prospect", "bench"]) {
      byStatus[s] = await count("contacts", "id, contact_emails!inner(id)", (q) =>
        q.eq("user_id", uid).eq("network_status", s)
      );
    }
    console.log(`Contacts total:                 ${totalContacts}`);
    console.log(`Contacts in the sync loop       ${loopSize}  (contacts with ≥1 email — synced one Gmail query at a time, serially)`);
    console.log(`  of which active:              ${byStatus.active}`);
    console.log(`  of which prospect:            ${byStatus.prospect}`);
    console.log(`  of which bench:               ${byStatus.bench}`);
    if (typeof loopSize === "number") {
      if (loopSize > 1000) {
        findings.push(
          `DEFECT TRIGGERED: the sync loop fetches contacts with one unpaginated query — Supabase caps that at 1000 rows, so ${loopSize - 1000} contacts are silently never synced.`
        );
      }
      const estMin = Math.round((loopSize * 0.7) / 60);
      console.log(`Estimated serial sync time:     ~${estMin} min at ~0.7s/contact`);
      if (loopSize * 0.7 > 60) {
        findings.push(
          `DEFECT TRIGGERED: a full sync needs roughly ${estMin} minutes, but it runs inside a single Vercel function invocation. It will be killed at the platform timeout, and the browser's fetch gives up even sooner — sync can no longer complete end-to-end at this contact count.`
        );
      }
    }

    // ── 4. Cache state ───────────────────────────────────────────────
    console.log("\n── Email cache ──");
    const totalMsgs = await count("email_messages", "id", (q) => q.eq("user_id", uid));
    const { data: newest } = await supabase
      .from("email_messages")
      .select("date, subject, direction")
      .eq("user_id", uid)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const recent = await count("email_messages", "id", (q) =>
      q.eq("user_id", uid).gte("date", new Date(Date.now() - 14 * 86_400_000).toISOString())
    );
    console.log(`Cached messages total:          ${totalMsgs}`);
    console.log(`Newest cached message:          ${newest?.date ?? "none"} (${fmtAge(newest?.date)}, ${newest?.direction ?? "-"})`);
    console.log(`Cached messages, last 14 days:  ${recent}`);
    if (typeof recent === "number" && recent === 0 && totalMsgs > 0) {
      findings.push(
        "SYMPTOM CONFIRMED: the cache has history but nothing from the last 14 days — sync has not landed a message in at least two weeks."
      );
    }
  }
}

// ── Verdict ──────────────────────────────────────────────────────────
console.log("\n══ Findings ══");
if (findings.length === 0) {
  console.log("No smoking gun found — connection healthy, workload sane, cache fresh.");
  console.log("If emails are still missing, the next suspect is the per-contact Gmail query/date-window logic.");
} else {
  findings.forEach((f, i) => console.log(`${i + 1}. ${f}`));
}
