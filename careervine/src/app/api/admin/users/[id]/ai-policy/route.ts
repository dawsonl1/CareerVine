import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { evictSharedAccessCache } from "@/lib/openai";

const schema = z.object({
  ai_fallback_policy: z.union([z.literal("cutoff"), z.literal("shared")]),
});

/**
 * PATCH /api/admin/users/[id]/ai-policy — set the account's shared-key
 * entitlement. Admin only.
 *
 * This is the dashboard face of the CAR-26 entitlement model: the wire
 * contract speaks 'shared' | 'cutoff', which maps onto
 * user_ai_access.shared_access (granted = 'shared'; default OFF = 'cutoff').
 * The machine route POST /api/admin/ai-access (token-authed) writes the same
 * table; this one is session-authed for the admin UI.
 *
 * The resolver caches entitlement per-instance for ≤60s, so a flip takes
 * effect within the cache TTL everywhere; the local eviction just makes this
 * instance immediate.
 */
export const PATCH = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const sharedAccess = body.ai_fallback_policy === "shared";
    const service = createSupabaseServiceClient();

    const { data: existing, error: readError } = await service
      .from("users")
      .select("id, email")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) throw new ApiError("User not found", 404);

    const { error } = await service.from("user_ai_access").upsert({
      user_id: id,
      shared_access: sharedAccess,
      granted_at: sharedAccess ? new Date().toISOString() : null,
      granted_by: sharedAccess ? admin.id : null,
      // Manual grants are permanent — and must overwrite a stale trial
      // expiry, or the upsert's conflict-merge would keep the user locked
      // (CAR-51). A grant also settles any pending access request.
      expires_at: null,
      ...(sharedAccess ? { access_requested_at: null } : {}),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new ApiError(`Policy update failed: ${error.message}`, 400);

    evictSharedAccessCache(id);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "set_ai_policy",
      detail: { shared_access: sharedAccess },
    });

    return { ok: true };
  },
});
