#!/usr/bin/env node
/**
 * One-off backfill (CAR-58): stamp gmail_connected / calendar_connected person
 * properties onto PostHog for every existing gmail_connections row.
 *
 * Needed because the gmail_connected event only ships from the OAuth callback
 * as of CAR-38 (2026-07-10) — every connection made before that has no event,
 * so connection state was invisible in PostHog. Going forward the connect/
 * disconnect events keep these properties current (see analytics/server.ts);
 * this script seeds the pre-tracking users once.
 *
 * Run manually from careervine/:
 *   node scripts/posthog-backfill-connection-state.mjs
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * NEXT_PUBLIC_POSTHOG_KEY from the environment or .env.local. Idempotent —
 * $set simply overwrites the same values.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Load .env.local when run outside the Next.js runtime.
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch {
  // no .env.local — rely on the ambient environment
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (!supabaseUrl || !serviceKey || !posthogKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or NEXT_PUBLIC_POSTHOG_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);
const { data: connections, error } = await supabase
  .from("gmail_connections")
  .select("user_id, gmail_address, calendar_scopes_granted, created_at");

if (error) {
  console.error("Failed to read gmail_connections:", error.message);
  process.exit(1);
}

let ok = 0;
for (const conn of connections ?? []) {
  const res = await fetch(`${posthogHost}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: posthogKey,
      event: "$set",
      distinct_id: conn.user_id,
      properties: {
        $set: {
          gmail_connected: true,
          calendar_connected: conn.calendar_scopes_granted === true,
          gmail_connected_at: conn.created_at,
        },
      },
    }),
  });
  if (res.ok) {
    ok++;
    console.log(`set ${conn.user_id} (${conn.gmail_address}) gmail=true calendar=${conn.calendar_scopes_granted === true}`);
  } else {
    console.error(`FAILED ${conn.user_id}: HTTP ${res.status} ${await res.text()}`);
  }
}

console.log(`Backfilled ${ok}/${connections?.length ?? 0} connections.`);
process.exit(ok === (connections?.length ?? 0) ? 0 : 1);
