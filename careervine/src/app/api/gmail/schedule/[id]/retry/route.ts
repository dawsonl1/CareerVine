import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus } from "@/lib/constants";

/**
 * POST /api/gmail/schedule/[id]/retry
 * Re-queues a failed scheduled email (CAR-134). Failed rows come from the
 * staleness sweeper — the send process died mid-flight and the email may or
 * may not have actually gone out, so retrying is an explicit user decision,
 * never automatic. Resets the send time to now so the row is immediately due:
 * the A1 send watcher picks it up within ~15s, with the hourly QStash sweep as
 * the safety net behind it (CAR-215). It is no longer a single ~15 min cron.
 */
export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const emailId = parseInt(params.id, 10);
    if (isNaN(emailId)) {
      throw new ApiError("Invalid ID", 400);
    }

    const service = createSupabaseServiceClient();
    const now = new Date().toISOString();

    // count, not .select(): the update writes the column the filter tests
    // (rule 17).
    const { count } = await service
      .from("scheduled_emails")
      .update(
        {
          status: ScheduledEmailStatus.Pending,
          claimed_at: null,
          scheduled_send_at: now,
          updated_at: now,
        },
        { count: "exact" },
      )
      .eq("id", emailId)
      .eq("user_id", user.id)
      .eq("status", ScheduledEmailStatus.Failed);

    if (!count) {
      throw new ApiError("This email is not in a failed state.", 409);
    }

    return { success: true };
  },
});
