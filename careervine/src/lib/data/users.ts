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

/** The user's Gmail connection row (settings + compose surfaces). */
export async function getGmailConnection(userId: string) {
  const { data, error } = await db()
    .from("gmail_connections")
    .select("id, gmail_address, last_gmail_sync_at, created_at, send_scope_granted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
