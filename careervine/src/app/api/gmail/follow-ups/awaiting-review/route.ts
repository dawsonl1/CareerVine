import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ACTIONABLE_FOLLOW_UP_MESSAGE_STATUSES } from "@/lib/constants";

/**
 * GET /api/gmail/follow-ups/awaiting-review — count of the user's follow-up
 * messages that still need their attention: parked awaiting_review OR expired
 * (still one-click sendable), under an active sequence (CAR-102/CAR-105). Drives
 * the free-tier nav badge (the paid badge uses /api/gmail/unread, which is always
 * 0 for free users with no synced inbound mail). DB-only, so not capability-gated;
 * a premium user just gets 0. Kept separate from /unread so it stays single-purpose.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const { count } = await service
      .from("email_follow_up_messages")
      .select("id, email_follow_ups!inner(user_id, status)", { count: "exact", head: true })
      .in("status", [...ACTIONABLE_FOLLOW_UP_MESSAGE_STATUSES])
      .eq("email_follow_ups.user_id", user.id)
      .eq("email_follow_ups.status", "active");

    return { count: count ?? 0 };
  },
});
