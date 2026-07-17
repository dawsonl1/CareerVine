/**
 * POST /api/ai/request-access (CAR-51)
 *
 * The second exit from the trial-expired locked state: the user asks the
 * owner for a manual shared-key grant. Records access_requested_at on their
 * entitlement row (the durable signal, visible even if email fails), emails
 * the owner fail-soft, and emits the engaged-user analytics event.
 *
 * Dedupe: one notification per 7 days per user — repeat clicks inside the
 * window return alreadyRequested without re-emailing. The per-user rate limit
 * keeps direct POSTs from ever turning this into an email cannon.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { notifyOwner } from "@/lib/admin-notify";

const RENOTIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const POST = withApiHandler({
  rateLimit: { bucket: "careervine-ai-request-access", limit: 3, window: "1 h" },
  handler: async ({ user, track }) => {
    const service = createSupabaseServiceClient();

    const { data: row, error: readError } = await service
      .from("user_ai_access")
      .select("shared_access, expires_at, granted_by, access_requested_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError) throw new ApiError("Failed to read access state", 500);

    const requestedAtMs = row?.access_requested_at
      ? new Date(row.access_requested_at).getTime()
      : null;
    if (requestedAtMs !== null && Date.now() - requestedAtMs < RENOTIFY_WINDOW_MS) {
      return { success: true, alreadyRequested: true };
    }

    const now = new Date().toISOString();
    const { error: upsertError } = await service.from("user_ai_access").upsert(
      {
        user_id: user.id,
        access_requested_at: now,
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
    if (upsertError) throw new ApiError("Failed to record request", 500);

    const email = user.email ?? "(no email on record)";
    await notifyOwner(
      `CareerVine: AI access request from ${email}`,
      [
        `${email} (user ${user.id}) requested continued shared-AI access.`,
        row?.granted_by === "trial"
          ? `Their 24h trial ${row.expires_at ? `expired ${row.expires_at}` : "has expired"}.`
          : "They have no shared-AI entitlement.",
        "",
        "Grant it from the admin dashboard (Users → AI policy), or:",
        `curl -X POST https://www.careervine.app/api/admin/ai-access \\`,
        `  -H "Authorization: Bearer $BUNDLE_ADMIN_TOKEN" -H "Content-Type: application/json" \\`,
        `  -d '{"email":"${email}","sharedAccess":true}'`,
      ].join("\n"),
    );

    track("ai_access_requested", {});
    return { success: true, alreadyRequested: false };
  },
});
