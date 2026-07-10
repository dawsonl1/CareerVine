import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
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
      .select("id, first_name, last_name, email, phone, status, apify_enrichment_enabled, diff_analysis_enabled, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!pub) throw new ApiError("User not found", 404);

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const [{ data: authData }, { data: keyRow }, { data: accessRow }, { data: spend }] =
      await Promise.all([
        service.auth.admin.getUserById(id),
        service
          .from("user_api_keys")
          .select("status")
          .eq("user_id", id)
          .eq("provider", "openai")
          .maybeSingle(),
        service
          .from("user_ai_access")
          .select("shared_access")
          .eq("user_id", id)
          .maybeSingle(),
        // Month-to-date Apify spend — shown next to the kill switches so the
        // toggle sits beside the number it controls (plan 36). Same RPC as
        // cap enforcement; best-effort here (null on error, never blocks).
        service.rpc("sum_scrape_spend", { p_user_id: id, p_since: monthStart }),
      ]);

    const user = shapeAdminUser(
      pub as PublicUserRow,
      authData?.user ?? undefined,
      keyStatusFor((keyRow as { status: string } | null)?.status),
      (accessRow as { shared_access: boolean } | null)?.shared_access === true,
    );

    return { user, apifyMonthSpendUsd: Number(spend ?? 0) };
  },
});

const patchSchema = z.object({
  first_name: z.string().trim().max(100).optional(),
  last_name: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().optional(),
});

/**
 * PATCH /api/admin/users/[id] — edit another account's profile. Admin only.
 *
 * Email is dual-source (auth.users is canonical; public.users.email mirrors it
 * with a UNIQUE constraint), so email changes update auth first and roll back
 * if the profile mirror fails — the two must never disagree silently.
 */
export const PATCH = withApiHandler<z.infer<typeof patchSchema>>({
  requireAdmin: true,
  schema: patchSchema,
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

    const emailChanging =
      body.email !== undefined && body.email !== (existing as { email: string | null }).email;

    // 1. Auth first (canonical). email_confirm skips the confirmation dance —
    //    this is an explicit admin action.
    if (emailChanging) {
      const { error } = await service.auth.admin.updateUserById(id, {
        email: body.email,
        email_confirm: true,
      });
      if (error) throw new ApiError(`Email update failed: ${error.message}`, 400);
    }

    // 2. Profile mirror.
    const profileUpdate: Record<string, unknown> = {};
    if (body.first_name !== undefined) profileUpdate.first_name = body.first_name;
    if (body.last_name !== undefined) profileUpdate.last_name = body.last_name;
    if (body.phone !== undefined) profileUpdate.phone = body.phone;
    if (emailChanging) profileUpdate.email = body.email;

    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await service.from("users").update(profileUpdate).eq("id", id);
      if (error) {
        // Compensate: put the auth email back so the two sources agree.
        if (emailChanging) {
          await service.auth.admin.updateUserById(id, {
            email: (existing as { email: string | null }).email ?? undefined,
            email_confirm: true,
          });
        }
        throw new ApiError(`Profile update failed: ${error.message}`, 400);
      }
    }

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "edit_profile",
      detail: { fields: Object.keys(profileUpdate) },
    });

    return { ok: true };
  },
});

/**
 * DELETE /api/admin/users/[id] — permanently delete an account. Admin only.
 *
 * auth.admin.deleteUser cascades through public.users (FK) into all of the
 * user's data. Guards: no self-delete, and admins must be demoted first so a
 * privileged account can't vanish in one click. The audit row is written after
 * deletion (admin_audit_log has no FKs by design) with the email preserved.
 */
export const DELETE = withApiHandler({
  requireAdmin: true,
  handler: async ({ user: admin, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    if (id === admin.id) {
      throw new ApiError("You can't delete your own account from here.", 400);
    }

    const { data: authData, error: lookupError } =
      await service.auth.admin.getUserById(id);
    if (lookupError || !authData?.user) throw new ApiError("User not found", 404);
    if (authData.user.app_metadata?.role === "admin") {
      throw new ApiError("Revoke this account's admin access before deleting it.", 400);
    }

    const email = authData.user.email ?? null;

    const { error } = await service.auth.admin.deleteUser(id);
    if (error) throw new ApiError(`Delete failed: ${error.message}`, 400);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "delete_account",
      detail: { email },
    });

    return { ok: true };
  },
});
