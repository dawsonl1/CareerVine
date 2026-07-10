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
      .select("id, first_name, last_name, email, phone, status, created_at")
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

    const [authById, keyRows, accessRows] = await Promise.all([
      listAllAuthUsers(service),
      service.from("user_api_keys").select("user_id, status").eq("provider", "openai"),
      service.from("user_ai_access").select("user_id, shared_access"),
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

    const users: AdminUserListItem[] = (rows as PublicUserRow[]).map((pub) => {
      const detail = shapeAdminUser(
        pub,
        authById.get(pub.id),
        keyStatusFor(keyStatusById.get(pub.id)),
        sharedAccessById.has(pub.id),
      );
      // List item omits phone (detail-only), but the shape is a superset — fine to return.
      return detail;
    });

    return { users };
  },
});
