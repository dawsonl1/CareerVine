import { z } from "zod";
import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  shapeAdminUser,
  listAllAuthUsers,
  keyStatusFor,
  sanitizeSearch,
  type AdminUserListItem,
  type PublicUserRow,
} from "@/lib/admin-users";
import { bundleVisibilityCount } from "@/lib/admin-bundles";

const querySchema = z.object({
  q: z.string().optional(),
});

/** GET /api/admin/users — searchable list of all accounts. Admin only. */
export const GET = withApiHandler<unknown, { q?: string }>({
  requireAdmin: true,
  querySchema,
  handler: async ({ query }) => {
    const service = createSupabaseServiceClient();

    let usersQuery = service
      .from("users")
      .select("id, first_name, last_name, email, phone, status, apify_enrichment_enabled, diff_analysis_enabled, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    const q = query.q ? sanitizeSearch(query.q) : "";
    if (q) {
      usersQuery = usersQuery.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`,
      );
    }

    const { data: rows, error } = await usersQuery;
    if (error) throw new Error(error.message);

    const ids = (rows as PublicUserRow[]).map((r) => r.id);

    const [authById, keyRows, accessRows, bundleRows, overrideRows] =
      await Promise.all([
        listAllAuthUsers(service),
        service.from("user_api_keys").select("user_id, status").eq("provider", "openai"),
        service.from("user_ai_access").select("user_id, shared_access"),
        service.from("data_bundles").select("id, default_visible").eq("status", "published"),
        // .in() with an empty list is invalid PostgREST — skip the query instead.
        ids.length
          ? service
              .from("bundle_access_overrides")
              .select("user_id, bundle_id, allowed")
              .in("user_id", ids)
          : Promise.resolve({ data: [], error: null }),
      ]);

    const keyStatusById = new Map<string, string>();
    for (const k of keyRows.data ?? []) {
      keyStatusById.set((k as { user_id: string }).user_id, (k as { status: string }).status);
    }
    const sharedAccessById = new Set<string>();
    for (const a of accessRows.data ?? []) {
      const row = a as { user_id: string; shared_access: boolean };
      if (row.shared_access) sharedAccessById.add(row.user_id);
    }

    const publishedBundles = ((bundleRows.data ?? []) as Array<{
      id: number;
      default_visible: boolean;
    }>).map((b) => ({ id: b.id, defaultVisible: b.default_visible }));

    const overridesByUser = new Map<string, Map<number, boolean>>();
    for (const o of overrideRows.data ?? []) {
      const row = o as { user_id: string; bundle_id: number; allowed: boolean };
      let forUser = overridesByUser.get(row.user_id);
      if (!forUser) {
        forUser = new Map();
        overridesByUser.set(row.user_id, forUser);
      }
      forUser.set(row.bundle_id, row.allowed);
    }
    const noOverrides = new Map<number, boolean>();

    const users: AdminUserListItem[] = (rows as PublicUserRow[]).map((pub) => {
      const base = shapeAdminUser(
        pub,
        authById.get(pub.id),
        keyStatusFor(keyStatusById.get(pub.id)),
        sharedAccessById.has(pub.id),
      );
      const bundles = bundleVisibilityCount(
        publishedBundles,
        overridesByUser.get(pub.id) ?? noOverrides,
      );
      // List item carries phone too (detail is a sibling shape) — harmless superset.
      return {
        ...base,
        bundlesVisible: bundles.visible,
        bundlesTotal: bundles.total,
      };
    });

    return { users };
  },
});
