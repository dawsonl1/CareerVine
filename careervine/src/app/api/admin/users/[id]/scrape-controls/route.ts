import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";

const schema = z
  .object({
    apify_enrichment_enabled: z.boolean().optional(),
    diff_analysis_enabled: z.boolean().optional(),
    discovery_enabled: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.apify_enrichment_enabled !== undefined ||
      b.diff_analysis_enabled !== undefined ||
      b.discovery_enabled !== undefined,
    { message: "At least one control must be provided" },
  );

/**
 * PATCH /api/admin/users/[id]/scrape-controls — flip the account's Apify
 * kill switches (plan 36): apify_enrichment_enabled gates all paid scraping,
 * diff_analysis_enabled gates change-event production, discovery_enabled
 * (plan 41, default off) gates the weekly new-hire discovery feed. Admin
 * only; takes effect on the next trigger/ingest (the flags are read at every
 * choke point, fail-closed).
 */
export const PATCH = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: existing, error: readError } = await service
      .from("users")
      .select("id, email")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) throw new ApiError("User not found", 404);

    const update: Record<string, boolean> = {};
    if (body.apify_enrichment_enabled !== undefined) update.apify_enrichment_enabled = body.apify_enrichment_enabled;
    if (body.diff_analysis_enabled !== undefined) update.diff_analysis_enabled = body.diff_analysis_enabled;
    if (body.discovery_enabled !== undefined) update.discovery_enabled = body.discovery_enabled;

    const { error } = await service.from("users").update(update).eq("id", id);
    if (error) throw new ApiError(`Controls update failed: ${error.message}`, 400);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "set_scrape_controls",
      detail: update,
    });

    return { ok: true, ...update };
  },
});
