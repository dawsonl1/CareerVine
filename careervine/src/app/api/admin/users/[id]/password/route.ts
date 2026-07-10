import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { revokeUserSessions } from "@/lib/admin-actions";

const schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("link") }),
  z.object({ mode: z.literal("set"), password: z.string().min(8).max(200) }),
]);

/**
 * POST /api/admin/users/[id]/password — admin password management.
 *
 * mode 'link': generates a single-use recovery link and RETURNS it to the
 *   admin (generateLink does not email anyone — the admin delivers it).
 * mode 'set': sets the password directly, then revokes all of the user's
 *   sessions so a possibly-compromised session can't outlive the reset.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ request, user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: authData, error: lookupError } =
      await service.auth.admin.getUserById(id);
    if (lookupError || !authData?.user) throw new ApiError("User not found", 404);
    const targetEmail = authData.user.email;
    if (!targetEmail) throw new ApiError("User has no email on file", 400);

    if (body.mode === "link") {
      const { data, error } = await service.auth.admin.generateLink({
        type: "recovery",
        email: targetEmail,
        options: {
          redirectTo: `${request.nextUrl.origin}/reset-password`,
        },
      });
      if (error) throw new ApiError(`Couldn't generate link: ${error.message}`, 400);

      await writeAudit(service, {
        adminId: admin.id,
        targetUserId: id,
        action: "password_reset_link",
      });

      return { actionLink: data.properties?.action_link ?? null };
    }

    // mode 'set'
    const { error } = await service.auth.admin.updateUserById(id, {
      password: body.password,
    });
    if (error) throw new ApiError(`Couldn't set password: ${error.message}`, 400);

    // Kill existing sessions — a password set is usually a recovery/compromise
    // action, and old sessions must not survive it.
    await revokeUserSessions(id);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "password_set",
      detail: { sessionsRevoked: true },
    });

    return { ok: true };
  },
});
