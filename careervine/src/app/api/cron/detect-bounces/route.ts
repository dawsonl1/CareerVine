import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { detectBounces } from "@/lib/gmail";
import { capabilitiesFor } from "@/lib/capabilities/map";
import { filterActiveUserIds } from "@/lib/user-status";
import { must } from "@/lib/data/client";

export const maxDuration = 60;

/**
 * POST /api/cron/detect-bounces
 * Daily QStash schedule (source of truth: scripts/qstash-schedules.mjs).
 *
 * Why this route exists (CAR-217): `detectBounces` had exactly one caller,
 * `POST /api/gmail/sync`, which runs when the user opens the Inbox or presses
 * "Sync now" in settings. So a bounce was only ever noticed while the user was
 * already looking at the app. Everything bounce handling does — retiring the
 * dead address, cancelling the follow-up sequence and the queued scheduled
 * mail, emailing the user — is unattended work whose entire value is happening
 * WITHOUT them watching. Until this route, a sequence could keep firing at a
 * dead address for as long as the user stayed out of the Inbox.
 *
 * Daily rather than hourly on purpose. An NDR arrives minutes after the send,
 * but nothing downstream is time-critical to the minute: the next queued send is
 * refused by `sendTrackedEmail`'s 422 in the meantime, so the worst case of a
 * slower cadence is a deferred cron tick, not a message into the void. Hourly
 * would burn the Vercel Fluid budget (CAR-106) on a per-user Gmail search that
 * almost always finds nothing.
 *
 * Scope: users whose connection resolves to `mailbox:read`. That is not a
 * product choice about who deserves the feature — a free connection holds
 * gmail.send alone (FREE_GMAIL_SCOPES) and physically cannot list these
 * messages. Everything downstream of detection stays ungated for all users.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () =>
    withCronGuard("/api/cron/detect-bounces", () => runJob()),
  );
}

interface ConnectionRow {
  user_id: string;
  modify_scope_granted: boolean | null;
  automatic_features_enabled: boolean | null;
  premium_enabled: boolean | null;
}

async function runJob(): Promise<NextResponse> {
  const service = createSupabaseServiceClient();

  const connections = must(
    await service
      .from("gmail_connections")
      .select("user_id, modify_scope_granted, automatic_features_enabled, premium_enabled"),
  ) as ConnectionRow[] | null;

  // Resolve capabilities from the same pre-fetch rather than per-user round
  // trips, matching send-follow-ups. `premium_enabled` defaults to true for
  // legacy rows, the same reading capabilitiesFor's callers already use.
  const eligible = (connections ?? []).filter((c) =>
    capabilitiesFor({
      modifyScopeGranted: c.modify_scope_granted ?? false,
      automaticFeaturesEnabled: c.automatic_features_enabled ?? true,
      premiumEnabled: c.premium_enabled ?? true,
      hasConnection: true,
    }).has("mailbox:read"),
  );

  // Suspension freezes an account: server-side automation must not act for a
  // suspended user, and sending them mail about it would be worse still.
  const active = await filterActiveUserIds(
    service,
    eligible.map((c) => c.user_id),
  );

  let scanned = 0;
  let newlyBounced = 0;
  let cancelledSequences = 0;
  let cancelledScheduled = 0;
  let failed = 0;

  for (const conn of eligible) {
    if (!active.has(conn.user_id)) continue;
    try {
      const result = await detectBounces(conn.user_id);
      scanned++;
      newlyBounced += result.newlyBounced.length;
      cancelledSequences += result.cancelledSequences;
      cancelledScheduled += result.cancelledScheduled;
    } catch (err) {
      // Per-user isolation: one revoked token or Gmail 5xx must not stop the
      // sweep for everyone behind it in the loop.
      failed++;
      console.error(`[cron detect-bounces] user ${conn.user_id} failed:`, err);
    }
  }

  return NextResponse.json({
    scanned,
    newlyBounced,
    cancelledSequences,
    cancelledScheduled,
    failed,
  });
}
