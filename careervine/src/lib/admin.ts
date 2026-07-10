/**
 * Admin authorization + audit helpers.
 *
 * The admin identity lives in auth.users.app_metadata.role (service-role
 * writable only — a user cannot self-promote). `withApiHandler({ requireAdmin })`
 * is the enforcement point for API routes; this module provides the shared
 * predicate and the audit-trail writer every admin mutation must call.
 */

import type { SupabaseClient, User } from "@supabase/supabase-js";

export const ADMIN_ROLE = "admin";

/** True when the user carries the admin claim in app_metadata. */
export function isAdmin(user: User | null | undefined): boolean {
  return user?.app_metadata?.role === ADMIN_ROLE;
}

export interface AuditEntry {
  /** The admin performing the action (the authenticated user's id). */
  adminId: string;
  /** The account acted upon, when applicable. */
  targetUserId?: string | null;
  /** Stable action slug, e.g. 'suspend' | 'set_password' | 'grant_bundle'. */
  action: string;
  /** Structured, non-secret context for the action. */
  detail?: Record<string, unknown>;
  /** Whether the underlying action succeeded. */
  outcome?: "ok" | "error";
}

/**
 * Append an admin action to admin_audit_log via the service-role client.
 *
 * Best-effort by design: an audit-write failure must never roll back or mask a
 * completed admin action, so this logs loudly and swallows rather than throwing.
 * Routes whose action + audit need to be atomic should instead perform both in a
 * single Postgres RPC.
 */
export async function writeAudit(
  service: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await service.from("admin_audit_log").insert({
    admin_id: entry.adminId,
    target_user_id: entry.targetUserId ?? null,
    action: entry.action,
    detail: entry.detail ?? {},
    outcome: entry.outcome ?? "ok",
  });

  if (error) {
    console.error(
      `[admin audit] FAILED to record action "${entry.action}" by ${entry.adminId} on ${entry.targetUserId ?? "-"}: ${error.message}`,
    );
  }
}
