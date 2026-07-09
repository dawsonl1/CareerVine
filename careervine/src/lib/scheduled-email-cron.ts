import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { processScheduledEmails } from "@/lib/gmail";

export interface ScheduledEmailCronResult {
  dueRows: number;
  usersProcessed: number;
  usersFailed: number;
  sent: number;
  errors: number;
}

interface DueUserRow {
  user_id: string;
}

interface ProcessDeps {
  service: SupabaseClient;
  processForUser: (userId: string) => Promise<{ sent: number; errors: number }>;
}

/**
 * Finds users with due scheduled emails and processes each user in isolation.
 * Errors from one user do not block other users in the same cron tick.
 */
export async function processDueScheduledEmails(
  nowIso: string = new Date().toISOString(),
  deps: Partial<ProcessDeps> = {},
): Promise<ScheduledEmailCronResult> {
  const service = deps.service ?? createSupabaseServiceClient();
  const processForUser = deps.processForUser ?? processScheduledEmails;

  const { data } = await service
    .from("scheduled_emails")
    .select("user_id")
    .eq("status", "pending")
    .lte("scheduled_send_at", nowIso)
    .order("scheduled_send_at", { ascending: true })
    .limit(200);

  const rows = (data as DueUserRow[] | null) ?? [];
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  if (userIds.length === 0) {
    return { dueRows: 0, usersProcessed: 0, usersFailed: 0, sent: 0, errors: 0 };
  }

  let usersProcessed = 0;
  let usersFailed = 0;
  let sent = 0;
  let errors = 0;

  for (const userId of userIds) {
    try {
      const result = await processForUser(userId);
      usersProcessed++;
      sent += result.sent;
      errors += result.errors;
    } catch {
      usersFailed++;
    }
  }

  return { dueRows: rows.length, usersProcessed, usersFailed, sent, errors };
}
