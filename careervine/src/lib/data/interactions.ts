/**
 * Interaction domain queries (CAR-146 split of queries.ts).
 *
 * Interactions are the lightweight touch log (calls, coffee chats, notes).
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db } from "./client";
import type { Database } from "@/lib/database.types";
import { activateContacts } from "./contacts";

/**
 * Fetch all interactions for a specific contact
 *
 * @param contactId - The contact's ID
 * @returns Promise<Interaction[]> - Array of interactions sorted by date (most recent first)
 * @throws Error if query fails
 */
export async function getInteractions(contactId: number) {
  const { data, error } = await db()
    .from("interactions")
    // exclusion-exempt: record view. The contact timeline needs struck rows so Show removed can reveal and restore them; it filters client-side.
    .select("*")
    .eq("contact_id", contactId)
    .order("interaction_date", { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Get all interactions for a user (across all contacts), with contact name.
 *
 * @param userId - The user's ID from auth.users
 * @returns Promise<Interaction[]> - Array of interactions with contact info, sorted by date desc
 * @throws Error if query fails
 */
export async function getAllInteractions(userId: string) {
  // Single query using an inner join on contacts — RLS on contacts ensures user scoping
  const { data, error } = await db()
    .from("interactions")
    .select("*, contacts!inner(id, name)")
    // CAR-260: struck by the user, so it must not count.
    .eq("is_excluded", false)
    .eq("contacts.user_id", userId)
    .order("interaction_date", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data || [];
}

/**
 * Create a new interaction for a contact
 *
 * @param interaction - Interaction data matching the interactions table schema (without id)
 * @returns Promise<Interaction> - The created interaction with generated id
 * @throws Error if creation fails
 */
export async function createInteraction(
  interaction: Database["public"]["Tables"]["interactions"]["Insert"]
) {
  const { data, error } = await db()
    .from("interactions")
    .insert(interaction)
    .select()
    .single();

  if (error) throw error;
  await activateContacts([interaction.contact_id]);
  return data;
}

/**
 * One interaction, scoped to its owner (CAR-275).
 *
 * `interactions` has no `user_id` column, so ownership rides the contacts join.
 * Under the request-scoped client that join is belt-and-braces over RLS; under
 * the MCP service client, which bypasses RLS, it is the ONLY thing between this
 * query and another tenant's row. Returns null when the id is not the user's,
 * which callers turn into a refusal rather than a silent write.
 */
export async function getInteractionForUser(id: number, userId: string) {
  const { data, error } = await db()
    .from("interactions")
    // exclusion-exempt: record view, not a derived value. An edit has to reach
    // a row the user already struck, or `excluded: false` could never put one
    // back. Nothing downstream counts what this returns.
    .select(
      "id, contact_id, interaction_date, interaction_type, interaction_type_detail, summary, is_excluded, email_message_id, contacts!inner(user_id)",
    )
    .eq("id", id)
    .eq("contacts.user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateInteraction(
  id: number,
  updates: Database["public"]["Tables"]["interactions"]["Update"]
) {
  // cas-checked: the only filter is the primary key, which is never a
  // written column, so this is a plain update-and-return rather than a
  // compare-and-set and the .select() readback is sound.
  const { data, error } = await db()
    .from("interactions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteInteraction(id: number) {
  const { error } = await db().from("interactions").delete().eq("id", id);
  if (error) throw error;
}
