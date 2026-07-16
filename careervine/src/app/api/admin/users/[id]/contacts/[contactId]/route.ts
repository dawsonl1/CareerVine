import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { cleanupContactPhoto } from "@/lib/contact-photo-cleanup";

/**
 * DELETE /api/admin/users/[id]/contacts/[contactId] — remove one contact from
 * the target account. Admin only.
 *
 * The ownership check matters: contact ids are enumerable integers and the
 * service client bypasses RLS, so without it an admin route could delete
 * another account's contact by id. Child rows (emails, phones, notes, links)
 * cascade via FK.
 */
export const DELETE = withApiHandler({
  requireAdmin: true,
  handler: async ({ user: admin, params }) => {
    const id = params.id;
    const contactId = Number(params.contactId);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      throw new ApiError("Invalid contact id", 400);
    }

    const service = createSupabaseServiceClient();

    const { data: contact, error: readError } = await service
      .from("contacts")
      .select("id, name, user_id, photo_url")
      .eq("id", contactId)
      .eq("user_id", id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!contact) throw new ApiError("Contact not found on this account", 404);

    const { error } = await service
      .from("contacts")
      .delete()
      .eq("id", contactId)
      .eq("user_id", id);
    if (error) throw new ApiError(`Delete failed: ${error.message}`, 400);

    // The contact's photo lives in R2 / legacy Supabase storage and doesn't
    // cascade with the DB row, so clear it explicitly (CAR-135 / R4.4).
    await cleanupContactPhoto(service, id, contactId, (contact as { photo_url: string | null }).photo_url);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "remove_contact",
      detail: { contactId, name: (contact as { name: string }).name },
    });

    return { ok: true };
  },
});
