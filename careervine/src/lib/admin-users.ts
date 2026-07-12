/**
 * Shared shapes + pure helpers for the admin user surface.
 *
 * The list/detail API routes gather data from four sources — public.users
 * (profile + status), auth.users (canonical email, last sign-in,
 * app_metadata.role), user_api_keys (key state), and user_ai_access (shared-key
 * entitlement, CAR-26) — and merge them through `shapeAdminUser` so the merge
 * logic is unit-testable in isolation. The UI-facing `aiFallbackPolicy` is
 * derived from the entitlement: shared_access granted → 'shared', else 'cutoff'
 * (the default-OFF model).
 */

import type { SupabaseClient, User } from "@supabase/supabase-js";

export type AdminUserKeyStatus =
  | "active"
  | "invalid"
  | "quota_exceeded"
  | "none";

export interface AdminUserBase {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: "active" | "suspended";
  aiFallbackPolicy: "cutoff" | "shared";
  apifyEnrichmentEnabled: boolean;
  diffAnalysisEnabled: boolean;
  discoveryEnabled: boolean;
  isAdmin: boolean;
  keyStatus: AdminUserKeyStatus;
  lastSignInAt: string | null;
  createdAt: string;
}

export interface AdminUserListItem extends AdminUserBase {
  /** Published bundles this user can currently see (CAR-36 list summary). */
  bundlesVisible: number;
  bundlesTotal: number;
}

export interface AdminUserDetail extends AdminUserBase {
  phone: string | null;
  /** CAR-103: automatic follow-ups toggle (default on for premium; admin opt-out). */
  automaticFeaturesEnabled: boolean;
  /** CAR-103: whether the Gmail connection holds the gmail.modify scope (token-fact). */
  modifyScopeGranted: boolean;
  /** CAR-102: admin master switch for the premium (Inbox) experience. */
  premiumEnabled: boolean;
  /** CAR-102: effective premium tier = modifyScopeGranted && premiumEnabled. */
  isPremium: boolean;
  /** CAR-103: whether the user has a Gmail connection at all. */
  hasGmailConnection: boolean;
}

/** The gmail_connections entitlement columns the admin surface reads (CAR-103/CAR-102). */
export interface GmailEntitlementRow {
  automatic_features_enabled: boolean;
  modify_scope_granted: boolean;
  premium_enabled: boolean;
}

/** The public.users columns the admin surface reads. */
export interface PublicUserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: "active" | "suspended";
  apify_enrichment_enabled: boolean;
  diff_analysis_enabled: boolean;
  discovery_enabled: boolean;
  created_at: string;
}

/** Minimal auth.users projection we need (from listUsers / getUserById). */
export interface AuthUserProjection {
  email?: string | null;
  last_sign_in_at?: string | null;
  // Supabase types app_metadata as an open record; role lives inside it.
  app_metadata?: Record<string, unknown> | null;
}

/**
 * Effective entitlement from a user_ai_access row (CAR-51): a grant counts
 * only while unexpired. Trials are flipped off lazily on their next AI use,
 * so the raw shared_access column can read true after the window closed —
 * every admin-facing display must go through this, not the raw column.
 */
export function isEffectivelyShared(
  row: { shared_access: boolean; expires_at: string | null } | null | undefined,
): boolean {
  if (!row?.shared_access) return false;
  return row.expires_at === null || new Date(row.expires_at).getTime() > Date.now();
}

/**
 * Merge the sources into one detail shape. Pure — no I/O.
 * Canonical email prefers the auth record, falling back to the profile row.
 * `sharedAccess` is the user_ai_access entitlement (absent row = false).
 */
export function shapeAdminUser(
  pub: PublicUserRow,
  auth: AuthUserProjection | undefined,
  keyStatus: AdminUserKeyStatus,
  sharedAccess: boolean,
  gmailConnection?: GmailEntitlementRow | null,
): AdminUserDetail {
  return {
    id: pub.id,
    firstName: pub.first_name ?? "",
    lastName: pub.last_name ?? "",
    email: auth?.email ?? pub.email ?? null,
    phone: pub.phone ?? null,
    status: pub.status,
    aiFallbackPolicy: sharedAccess ? "shared" : "cutoff",
    apifyEnrichmentEnabled: pub.apify_enrichment_enabled,
    diffAnalysisEnabled: pub.diff_analysis_enabled,
    discoveryEnabled: pub.discovery_enabled,
    isAdmin: auth?.app_metadata?.role === "admin",
    keyStatus,
    lastSignInAt: auth?.last_sign_in_at ?? null,
    createdAt: pub.created_at,
    automaticFeaturesEnabled: gmailConnection?.automatic_features_enabled ?? false,
    modifyScopeGranted: gmailConnection?.modify_scope_granted ?? false,
    // Premium switch fails OPEN to true (matches the column default + resolver),
    // so a missing value never reads as "downgraded" in the admin view.
    premiumEnabled: gmailConnection?.premium_enabled ?? true,
    isPremium: (gmailConnection?.modify_scope_granted ?? false) && (gmailConnection?.premium_enabled ?? true),
    hasGmailConnection: !!gmailConnection,
  };
}

/** Fetch every auth user, paging through listUsers, indexed by id. */
export async function listAllAuthUsers(
  service: SupabaseClient,
): Promise<Map<string, User>> {
  const byId = new Map<string, User>();
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) byId.set(u.id, u);
    if (data.users.length < perPage) break;
  }
  return byId;
}

/** Map a user_api_keys row (or its absence) to a display key status. */
export function keyStatusFor(
  status: string | null | undefined,
): AdminUserKeyStatus {
  if (status === "active" || status === "invalid" || status === "quota_exceeded") {
    return status;
  }
  return "none";
}

/** Sanitize free-text search for a PostgREST `.or(...ilike...)` filter. */
export function sanitizeSearch(q: string): string {
  // Strip characters that would break the or() filter grammar.
  return q.replace(/[,()%*]/g, " ").trim();
}
