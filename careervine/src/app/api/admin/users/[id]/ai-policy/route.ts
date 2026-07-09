import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { evictOpenAIKeyCache } from "@/lib/openai";

const schema = z.object({
  ai_fallback_policy: z.union([z.literal("cutoff"), z.literal("shared")]),
});

/**
 * PATCH /api/admin/users/[id]/ai-policy — set the account's AI fallback
 * policy. Admin only.
 *
 * The resolver caches per-instance for ≤60s, so a flip takes effect within
 * the cache TTL everywhere; the local eviction just makes this instance
 * immediate.
 */
export const PATCH = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: existing, error: readError } = await service
      .from("users")
      .select("id, email, ai_fallback_policy")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) throw new ApiError("User not found", 404);

    const { error } = await service
      .from("users")
      .update({ ai_fallback_policy: body.ai_fallback_policy })
      .eq("id", id);
    if (error) throw new ApiError(`Policy update failed: ${error.message}`, 400);

    evictOpenAIKeyCache(id);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "set_ai_policy",
      detail: {
        from: (existing as { ai_fallback_policy: string }).ai_fallback_policy,
        to: body.ai_fallback_policy,
      },
    });

    return { ok: true };
  },
});
