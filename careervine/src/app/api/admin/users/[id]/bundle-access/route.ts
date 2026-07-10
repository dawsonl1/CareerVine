import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import {
  effectiveBundleVisibility,
  type BundleAccessItem,
} from "@/lib/admin-bundles";

/**
 * GET /api/admin/users/[id]/bundle-access — every published bundle with this
 * user's override, effective visibility, and subscription state. Admin only
 * (service client: hidden bundles + the overrides table are invisible to
 * user-scoped clients by design).
 */
export const GET = withApiHandler({
  requireAdmin: true,
  handler: async ({ params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const [{ data: bundles, error }, { data: overrides }, { data: subs }] =
      await Promise.all([
        service
          .from("data_bundles")
          .select("id, slug, name, description, prospect_count, default_visible")
          .eq("status", "published")
          .order("published_at", { ascending: false }),
        service
          .from("bundle_access_overrides")
          .select("bundle_id, allowed")
          .eq("user_id", id),
        service
          .from("bundle_subscriptions")
          .select("bundle_id, status")
          .eq("user_id", id)
          .eq("status", "active"),
      ]);
    if (error) throw new Error(error.message);

    const overrideByBundle = new Map(
      ((overrides as Array<{ bundle_id: number; allowed: boolean }>) ?? []).map(
        (o) => [o.bundle_id, o.allowed],
      ),
    );
    const subscribedBundles = new Set(
      ((subs as Array<{ bundle_id: number }>) ?? []).map((s) => s.bundle_id),
    );

    const items: BundleAccessItem[] = (
      (bundles as Array<{
        id: number;
        slug: string;
        name: string;
        description: string | null;
        prospect_count: number;
        default_visible: boolean;
      }>) ?? []
    ).map((b) => {
      const override = overrideByBundle.has(b.id)
        ? (overrideByBundle.get(b.id) as boolean)
        : null;
      return {
        bundleId: b.id,
        slug: b.slug,
        name: b.name,
        description: b.description,
        prospectCount: b.prospect_count,
        defaultVisible: b.default_visible,
        override,
        visible: effectiveBundleVisibility(b.default_visible, override),
        subscribed: subscribedBundles.has(b.id),
      };
    });

    return { bundles: items };
  },
});

const putSchema = z.object({
  bundleId: z.number().int().positive(),
  /** true = grant, false = deny, null = clear override (back to default). */
  allowed: z.union([z.boolean(), z.null()]),
});

/** PUT /api/admin/users/[id]/bundle-access — set/clear one override. */
export const PUT = withApiHandler<z.infer<typeof putSchema>>({
  requireAdmin: true,
  schema: putSchema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: bundle } = await service
      .from("data_bundles")
      .select("id, name")
      .eq("id", body.bundleId)
      .maybeSingle();
    if (!bundle) throw new ApiError("Bundle not found", 404);

    if (body.allowed === null) {
      const { error } = await service
        .from("bundle_access_overrides")
        .delete()
        .eq("user_id", id)
        .eq("bundle_id", body.bundleId);
      if (error) throw new ApiError(`Couldn't clear override: ${error.message}`, 400);
    } else {
      const { error } = await service.from("bundle_access_overrides").upsert({
        user_id: id,
        bundle_id: body.bundleId,
        allowed: body.allowed,
        updated_by: admin.id,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new ApiError(`Couldn't set override: ${error.message}`, 400);
    }

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action:
        body.allowed === null
          ? "clear_bundle_override"
          : body.allowed
            ? "grant_bundle"
            : "deny_bundle",
      detail: { bundleId: body.bundleId, bundleName: (bundle as { name: string }).name },
    });

    return { ok: true };
  },
});
