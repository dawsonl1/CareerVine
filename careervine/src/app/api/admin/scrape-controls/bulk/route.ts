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
 * POST /api/admin/scrape-controls/bulk — the "toggle all at once" switch
 * (plan 36): apply the given Apify kill-switch values to EVERY account.
 * Admin only. Returns the number of accounts updated.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  requireAdmin: true,
  schema,
  handler: async ({ user: admin, body }) => {
    const service = createSupabaseServiceClient();

    const update: Record<string, boolean> = {};
    if (body.apify_enrichment_enabled !== undefined) update.apify_enrichment_enabled = body.apify_enrichment_enabled;
    if (body.diff_analysis_enabled !== undefined) update.diff_analysis_enabled = body.diff_analysis_enabled;
    if (body.discovery_enabled !== undefined) update.discovery_enabled = body.discovery_enabled;

    // not-is-null on id = an always-true predicate PostgREST accepts for a
    // deliberate full-table UPDATE (it refuses a bare unfiltered update).
    const { count, error } = await service
      .from("users")
      .update(update, { count: "exact" })
      .not("id", "is", null);
    if (error) throw new ApiError(`Bulk update failed: ${error.message}`, 400);

    await writeAudit(service, {
      adminId: admin.id,
      action: "set_scrape_controls_all",
      detail: { ...update, affected: count ?? 0 },
    });

    return { ok: true, affected: count ?? 0, ...update };
  },
});
