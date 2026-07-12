import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";

const schema = z.object({
  premium_enabled: z.boolean(),
});

/**
 * PATCH /api/admin/users/[id]/premium — the master premium (Inbox) switch (CAR-102).
 *
 * Flips premium_enabled on the user's gmail_connections row. Premium =
 * modify_scope_granted (a truthful token-fact) AND premium_enabled (this admin
 * switch), so turning it off moves the user to the free Outreach tier WITHOUT a
 * reconnect and without touching modify_scope_granted. Admin only.
 *
 * The flag lives on gmail_connections, which may not exist. A silent 0-row update
 * reads as success (rule 17), so we update with an exact count and treat count 0
 * as "no Gmail connection" (404).
 */
export const PATCH = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { count, error } = await service
      .from("gmail_connections")
      .update({ premium_enabled: body.premium_enabled }, { count: "exact" })
      .eq("user_id", id);

    if (error) throw new ApiError(`Update failed: ${error.message}`, 400);
    if (!count) {
      throw new ApiError(
        "This account has no Gmail connection to change the premium tier on.",
        404,
      );
    }

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "set_premium",
      detail: { premium_enabled: body.premium_enabled },
    });

    return { ok: true, premium_enabled: body.premium_enabled };
  },
});
