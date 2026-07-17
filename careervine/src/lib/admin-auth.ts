/**
 * Shared auth + hardening for the BUNDLE_ADMIN_TOKEN machine routes
 * (bundles/publish, ai-access). These routes have no user session — they're
 * driven by a bearer token from the owner's machine — so the auth predicate,
 * audit helper, and rate limiter live here rather than inside any one route
 * file. Previously `isAuthorizedAdminToken` was exported from the
 * bundles/publish route module and imported cross-route (CAR-140 / F25); this
 * makes src/lib the single downward-pointing home for it.
 */

import { createHash, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAudit } from "@/lib/admin";
import { checkRateLimit, type RateLimitWindow } from "@/lib/rate-limit";

/** Human-readable actor label recorded in the audit trail for machine-token actions. */
export const MACHINE_ADMIN_ACTOR = "machine:bundle-admin-token";

/**
 * admin_audit_log.admin_id is `uuid NOT NULL` (no FK). Machine-token routes have
 * no user session, so they record actions under this nil-UUID sentinel and carry
 * the real actor label in detail.actor. Storing the label directly in admin_id
 * would throw 22P02 and — because writeAudit swallows errors — silently write no
 * row at all. The sentinel keeps the trail honest with zero schema change.
 */
export const MACHINE_ADMIN_AUDIT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Constant-time bearer check; SHA-256 digesting both sides equalizes length so
 * timingSafeEqual never throws on mismatched input sizes.
 */
export function isAuthorizedAdminToken(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Append an admin_audit_log row for a BUNDLE_ADMIN_TOKEN machine action. Logged
 * under the nil-UUID sentinel with detail.actor = the machine actor label.
 * Best-effort (writeAudit never throws) — an audit write must not block the action.
 */
export async function writeMachineTokenAudit(
  service: SupabaseClient,
  entry: {
    action: string;
    targetUserId?: string | null;
    detail?: Record<string, unknown>;
    outcome?: "ok" | "error";
  },
): Promise<void> {
  await writeAudit(service, {
    adminId: MACHINE_ADMIN_AUDIT_ID,
    targetUserId: entry.targetUserId ?? null,
    action: entry.action,
    detail: { actor: MACHINE_ADMIN_ACTOR, ...entry.detail },
    outcome: entry.outcome ?? "ok",
  });
}

/**
 * Coarse rate limit for a machine-token route. Keyed on a fixed machine actor id
 * (no user session exists), namespaced per route by `bucket`. Applied after the
 * bearer check passes, so it bounds the blast radius of a leaked token without
 * letting an unauthenticated caller exhaust a legitimate driver's budget.
 * Returns true when the request is allowed. Degrades to allow-all when Upstash
 * env is unset (see rate-limit.ts), so local/dev is never blocked.
 */
export async function checkMachineRateLimit(
  bucket: string,
  limit: number,
  window: RateLimitWindow = "60 s",
): Promise<boolean> {
  const { allowed } = await checkRateLimit(MACHINE_ADMIN_ACTOR, { bucket, limit, window });
  return allowed;
}
