import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { revokeUserSessions, SUSPEND_BAN_DURATION } from "@/lib/admin-actions";

const schema = z.object({
  status: z.union([z.literal("active"), z.literal("suspended")]),
});

/**
 * POST /api/admin/users/[id]/status — suspend / reactivate. Admin only.
 *
 * Suspend = freeze the account, enforced at three layers:
 *  1. GoTrue ban (ban_duration) — rejects login AND token refresh natively.
 *  2. Session revocation — existing sessions die immediately (getUser()
 *     round-trips to GoTrue, so API access stops without any hot-path check).
 *  3. users.status — cron guards skip suspended users' queued work (held,
 *     not dropped; it resumes on reactivation).
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const suspending = body.status === "suspended";
    const service = createSupabaseServiceClient();

    if (suspending && id === admin.id) {
      throw new ApiError("You can't suspend your own account.", 400);
    }

    const { data: authData, error: lookupError } =
      await service.auth.admin.getUserById(id);
    if (lookupError || !authData?.user) throw new ApiError("User not found", 404);

    // 1. GoTrue ban / unban (auth-level enforcement).
    const { error: banError } = await service.auth.admin.updateUserById(id, {
      ban_duration: suspending ? SUSPEND_BAN_DURATION : "none",
    });
    if (banError) throw new ApiError(`Status change failed: ${banError.message}`, 400);

    // 2. DB status (source of truth for UI + cron guards).
    const { error: statusError } = await service
      .from("users")
      .update({ status: body.status })
      .eq("id", id);
    if (statusError) {
      // Compensate the ban so the two layers can't disagree.
      await service.auth.admin.updateUserById(id, {
        ban_duration: suspending ? "none" : SUSPEND_BAN_DURATION,
      });
      throw new ApiError(`Status change failed: ${statusError.message}`, 400);
    }

    // 3. Kill live sessions on suspend.
    if (suspending) await revokeUserSessions(id);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: suspending ? "suspend" : "reactivate",
      detail: { email: authData.user.email ?? null },
    });

    return { ok: true };
  },
});
