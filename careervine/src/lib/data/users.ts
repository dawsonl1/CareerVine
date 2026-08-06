/**
 * User profile and settings queries (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db } from "./client";
import type { Database } from "@/lib/database.types";

/**
 * Get the user's profile from the public.users table.
 *
 * @param userId - The user's ID (UUID from auth.users)
 * @returns Promise<UserRow> - The user's profile data
 * @throws Error if query fails or user not found
 */
export async function getUserProfile(userId: string) {
  const { data, error } = await db()
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Update the user's profile in the public.users table.
 *
 * @param userId - The user's ID (UUID from auth.users)
 * @param updates - Partial user data to update (first_name, last_name, phone)
 * @returns Promise<UserRow> - The updated profile
 * @throws Error if update fails
 */
export async function updateUserProfile(
  userId: string,
  updates: Database["public"]["Tables"]["users"]["Update"]
) {
  // cas-checked: the only filter is the primary key, which is never a
  // written column, so this is a plain update-and-return rather than a
  // compare-and-set and the .select() readback is sound.
  const { data, error } = await db()
    .from("users")
    .update(updates)
    .eq("id", userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * The account holder's school (CAR-213), the input to every alum badge, count,
 * sort, and copy variant in the app.
 *
 * Lives here rather than in company-queries or mcp/lib/db so web and MCP share
 * one implementation and one set of scoping guarantees — the CAR-151
 * convention, which check:conventions enforces.
 *
 * public.users is CANONICAL. Never read the user_metadata mirror for this: it
 * is user-writable through the Supabase client, so trusting it would let
 * anyone grant themselves the alumni-only bundle prospects.
 */
export async function getUserSchool(
  userId: string,
  /**
   * Explicit client for callers on a DIFFERENT seam. company-queries owns its
   * own (`setCompanyQueriesClient`) because MCP injects a service-role client
   * there, so calling this without one would silently read through whichever
   * client the data seam happens to hold — unwired in some contexts, and a
   * cross-seam coupling nothing declares in the others.
   */
  client?: ReturnType<typeof db>,
): Promise<string | null> {
  const { data, error } = await (client ?? db())
    .from("users")
    .select("university")
    .eq("id", userId)
    .maybeSingle();
  // Fail loud: a swallowed read reports every contact as a non-alum, which is
  // indistinguishable downstream from a correct answer.
  if (error) throw error;
  return data?.university ?? null;
}

/**
 * Read the set of getting-started checklist row IDs the user has dismissed on
 * the Home page (CAR-73). Returns [] when the column is empty/absent.
 */
export async function getDismissedGettingStarted(userId: string): Promise<string[]> {
  const { data, error } = await db()
    .from("users")
    .select("dismissed_getting_started")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data?.dismissed_getting_started ?? [];
}

/**
 * Persist the full set of dismissed getting-started row IDs. The client owns
 * the set (it already knows the current dismissals plus the new one), so we
 * write the whole array rather than array_append — no RPC, no read-modify-write
 * race between rapid dismissals.
 */
export async function setDismissedGettingStarted(userId: string, ids: string[]): Promise<void> {
  const { error } = await db()
    .from("users")
    .update({ dismissed_getting_started: ids })
    .eq("id", userId);
  if (error) throw error;
}

/**
 * The user's Gmail connection row, for a surface that mounts on ONE page.
 *
 * Never call this from anything the app shell renders on every route (a root
 * layout provider, navigation, a global modal). `/api/gmail/connection` selects
 * a strict superset of these columns and `useGmailConnection()` shares one
 * fetch of it across every consumer, so a shell-level caller here is a second
 * gmail_connections read on every page load that learns nothing new — which is
 * what CAR-229 removed from `components/compose-email-context.tsx`.
 */
export async function getGmailConnection(userId: string) {
  const { data, error } = await db()
    .from("gmail_connections")
    .select("id, gmail_address, last_gmail_sync_at, created_at, send_scope_granted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
