/**
 * Server-side helpers for privileged admin actions on user accounts.
 *
 * These run only inside /api/admin/** routes (behind `requireAdmin`) on the
 * service-role client. Anything here that GoTrue's JS client doesn't wrap
 * (session revocation) calls the GoTrue admin REST API directly.
 */

import { getSupabaseEnv } from "@/lib/supabase/config";

/**
 * Revoke every session (all refresh tokens) for a user.
 *
 * The JS client's `auth.admin.signOut(jwt)` needs the *user's* JWT, which an
 * admin doesn't have — but GoTrue exposes an admin logout endpoint keyed by
 * user id. After this, the user's next `getUser()` round-trip fails and they
 * must sign in again.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseEnv({ server: true });
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}/logout`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  // 404 = no active sessions, which is fine; anything else is a real failure.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to revoke sessions (${res.status}): ${body}`);
  }
}

/** ~100 years — GoTrue has no permanent ban flag, only a duration. */
export const SUSPEND_BAN_DURATION = "876000h";

export type RoleChangeCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Guards for the make/revoke-admin control:
 *  - an admin cannot revoke their own admin role (self-lockout),
 *  - the last remaining admin cannot be demoted (system lockout).
 * Pure — callers supply the current admin count.
 */
export function checkRoleChange(opts: {
  actingAdminId: string;
  targetUserId: string;
  nextRole: "admin" | null;
  targetIsAdmin: boolean;
  adminCount: number;
}): RoleChangeCheck {
  const { actingAdminId, targetUserId, nextRole, targetIsAdmin, adminCount } = opts;

  if (nextRole === null) {
    if (!targetIsAdmin) {
      return { ok: false, reason: "That account is not an admin." };
    }
    if (targetUserId === actingAdminId) {
      return { ok: false, reason: "You can't revoke your own admin access." };
    }
    if (adminCount <= 1) {
      return { ok: false, reason: "You can't remove the last remaining admin." };
    }
  } else if (targetIsAdmin) {
    return { ok: false, reason: "That account is already an admin." };
  }

  return { ok: true };
}
