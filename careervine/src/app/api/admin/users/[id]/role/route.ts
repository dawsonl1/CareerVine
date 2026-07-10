import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit, ADMIN_ROLE } from "@/lib/admin";
import { checkRoleChange } from "@/lib/admin-actions";
import { listAllAuthUsers } from "@/lib/admin-users";

const schema = z.object({
  role: z.union([z.literal("admin"), z.null()]),
});

/**
 * POST /api/admin/users/[id]/role — make or revoke admin. Admin only.
 *
 * Guards: no self-revoke (self-lockout) and no revoking the last remaining
 * admin (system lockout). The change rides app_metadata, so it takes effect
 * on the target's next token refresh / sign-in.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: authData, error: lookupError } =
      await service.auth.admin.getUserById(id);
    if (lookupError || !authData?.user) throw new ApiError("User not found", 404);

    const target = authData.user;
    const targetIsAdmin = target.app_metadata?.role === ADMIN_ROLE;

    // Count current admins for the last-admin guard (only needed on revoke,
    // but cheap enough to always compute correctly).
    let adminCount = 0;
    if (body.role === null) {
      const all = await listAllAuthUsers(service);
      for (const u of all.values()) {
        if (u.app_metadata?.role === ADMIN_ROLE) adminCount++;
      }
    }

    const check = checkRoleChange({
      actingAdminId: admin.id,
      targetUserId: id,
      nextRole: body.role,
      targetIsAdmin,
      adminCount,
    });
    if (!check.ok) throw new ApiError(check.reason, 400);

    const nextAppMetadata = { ...(target.app_metadata ?? {}) };
    if (body.role === ADMIN_ROLE) nextAppMetadata.role = ADMIN_ROLE;
    else delete nextAppMetadata.role;

    const { error } = await service.auth.admin.updateUserById(id, {
      app_metadata: nextAppMetadata,
    });
    if (error) throw new ApiError(`Role update failed: ${error.message}`, 400);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: body.role === ADMIN_ROLE ? "grant_admin" : "revoke_admin",
    });

    return { ok: true };
  },
});
