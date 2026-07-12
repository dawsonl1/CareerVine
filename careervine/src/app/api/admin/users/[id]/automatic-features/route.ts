import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";

const schema = z.object({
  automatic_features_enabled: z.boolean(),
});

/**
 * PATCH /api/admin/users/[id]/automatic-features — grant or revoke the paid
 * automatic-features entitlement (CAR-103). Flips automatic_features_enabled on
 * the user's gmail_connections row; the capability resolver reads it. Admin only.
 *
 * The entitlement lives on gmail_connections, which may not exist. A silent
 * 0-row update reads as success (rule 17), so we update with an exact count and
 * treat count 0 as "no Gmail connection" (404) — there is nothing to automate
 * without one.
 */
export const PATCH = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { count, error } = await service
      .from("gmail_connections")
      .update(
        { automatic_features_enabled: body.automatic_features_enabled },
        { count: "exact" },
      )
      .eq("user_id", id);

    if (error) throw new ApiError(`Update failed: ${error.message}`, 400);
    if (!count) {
      throw new ApiError(
        "This account has no Gmail connection to enable automatic features on.",
        404,
      );
    }

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "set_automatic_features",
      detail: { automatic_features_enabled: body.automatic_features_enabled },
    });

    return { ok: true, automatic_features_enabled: body.automatic_features_enabled };
  },
});
