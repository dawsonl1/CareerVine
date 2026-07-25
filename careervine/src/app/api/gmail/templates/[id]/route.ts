import { withApiHandler } from "@/lib/api-handler";
import { idParamSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/gmail/templates/:id
 *
 * `paramsSchema` rather than a bare `parseInt` (CAR-183): parseInt is lenient,
 * so "3abc" parsed to 3 and deleted a different, valid template, while "abc"
 * parsed to NaN, reached Postgres as `id=eq.NaN`, and surfaced a client input
 * error as a 500 with an `api_error` telemetry event. `idParamSchema` turns
 * both into a 400. Matches the sibling cancel route in the same feature area.
 */
export const DELETE = withApiHandler({
  paramsSchema: idParamSchema,
  handler: async ({ user, params }) => {
    const service = createSupabaseServiceClient();
    const { error } = await service
      .from("email_templates")
      .delete()
      .eq("id", params.id)
      .eq("user_id", user.id);

    if (error) throw error;
    return { success: true };
  },
});
