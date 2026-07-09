import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  shapeAdminUser,
  keyStatusFor,
  type PublicUserRow,
} from "@/lib/admin-users";

/** GET /api/admin/users/[id] — full detail for one account. Admin only. */
export const GET = withApiHandler({
  requireAdmin: true,
  handler: async ({ params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: pub, error } = await service
      .from("users")
      .select("id, first_name, last_name, email, phone, status, ai_fallback_policy, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!pub) throw new ApiError("User not found", 404);

    const [{ data: authData }, { data: keyRow }] = await Promise.all([
      service.auth.admin.getUserById(id),
      service
        .from("user_api_keys")
        .select("status")
        .eq("user_id", id)
        .eq("provider", "openai")
        .maybeSingle(),
    ]);

    const user = shapeAdminUser(
      pub as PublicUserRow,
      authData?.user ?? undefined,
      keyStatusFor((keyRow as { status: string } | null)?.status),
    );

    return { user };
  },
});
