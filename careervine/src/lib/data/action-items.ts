/**
 * Action-item domain queries: follow_up_action_items CRUD plus the
 * action_item_contacts junction (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure.
 */

import { db, must, type QueryClient } from "./client";
import { paginateAll } from "./postgrest";
import type { Database } from "@/lib/database.types";

/**
 * Create a follow-up action item with optional multiple contacts
 *
 * @param actionItem - Action item data (contact_id is kept for legacy compat)
 * @param contactIds - Array of contact IDs to associate
 * @param client - Optional injected client (server routes pass their own)
 * @returns Promise<ActionItem> - The created action item
 * @throws Error if creation fails
 */
export async function createActionItem(
  actionItem: Database["public"]["Tables"]["follow_up_action_items"]["Insert"],
  contactIds?: number[],
  client?: QueryClient
) {
  const dbc = client ?? db();
  const { data, error } = await dbc
    .from("follow_up_action_items")
    .insert(actionItem)
    .select()
    .single();

  if (error) throw error;

  // Insert into junction table
  const ids = contactIds ?? (actionItem.contact_id ? [actionItem.contact_id] : []);
  if (ids.length > 0) {
    const { error: junctionError } = await dbc
      .from("action_item_contacts")
      .insert(ids.map((cid) => ({ action_item_id: data.id, contact_id: cid })));
    if (junctionError) throw junctionError;
  }

  return data;
}

/**
 * Fetch all pending action items for a user
 *
 * This queries the follow_up_action_items table and includes
 * the related contact information for each action item.
 *
 * @param userId - The user's ID
 * @returns Promise<ActionItem[]> - Array of incomplete action items sorted by due date
 * @throws Error if query fails
 */
export async function getActionItems(userId: string) {
  const now = new Date().toISOString();
  // paginateAll: this is the unfiltered pending set for both the web action
  // list and MCP's listActionItems, which narrows by direction/contact/due in
  // memory — a 1000-row truncation here would silently under-return whole
  // slices of those views. .order("id") is the stable tiebreaker range
  // pagination needs (due_at is nullable and heavily duplicated).
  return await paginateAll(async (from, to) =>
    must(
      await db()
        .from("follow_up_action_items")
        .select(`
          *,
          contacts(*),
          meetings(*),
          action_item_contacts(contact_id, contacts(id, name))
        `)
        .eq("user_id", userId)
        .eq("is_completed", false)
        .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("id")
        .range(from, to),
    ),
  );
}

/**
 * Fetch action items linked to a specific meeting
 *
 * @param meetingId - The meeting's ID
 * @returns Promise<ActionItem[]> - Array of action items with contact info
 * @throws Error if query fails
 */
export async function getActionItemsForMeeting(meetingId: number) {
  const { data, error } = await db()
    .from("follow_up_action_items")
    .select(`
      *,
      contacts(id, name),
      action_item_contacts(contact_id, contacts(id, name))
    `)
    .eq("meeting_id", meetingId)
    .order("id", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Get pending (incomplete) action items for a specific contact.
 * Queries via the action_item_contacts junction table, then flattens
 * and filters to incomplete items sorted by due date.
 *
 * @param contactId - The contact's ID
 * @returns Promise<ActionItem[]> - Incomplete action items sorted by due date
 * @throws Error if query fails
 */
export async function getActionItemsForContact(contactId: number) {
  const { data, error } = await db()
    .from("action_item_contacts")
    .select(`
      action_item_id,
      follow_up_action_items(
        *,
        meetings(id, meeting_type, meeting_date),
        action_item_contacts(contact_id, contacts(id, name))
      )
    `)
    .eq("contact_id", contactId)
    .not("follow_up_action_items", "is", null);

  if (error) throw error;
  // Flatten: extract the action items and filter to incomplete
  const items = (data || [])
    .map((row) => row.follow_up_action_items)
    .filter((item): item is NonNullable<typeof item> => item != null && !item.is_completed)
    .sort((a, b) => {
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });
  return items;
}

/**
 * Get all completed action items for a user, sorted by completion date desc.
 *
 * @param userId - The user's ID
 * @returns Promise<ActionItem[]> - Completed action items
 * @throws Error if query fails
 */
export async function getCompletedActionItems(userId: string) {
  const { data, error } = await db()
    .from("follow_up_action_items")
    .select(`
      *,
      contacts(*),
      meetings(*),
      action_item_contacts(contact_id, contacts(id, name))
    `)
    .eq("user_id", userId)
    .eq("is_completed", true)
    .order("completed_at", { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Get completed action items for a specific contact.
 * Queries via the action_item_contacts junction table.
 *
 * @param contactId - The contact's ID
 * @returns Promise<ActionItem[]> - Completed action items sorted by completion date desc
 * @throws Error if query fails
 */
export async function getCompletedActionItemsForContact(contactId: number) {
  const { data, error } = await db()
    .from("action_item_contacts")
    .select(`
      action_item_id,
      follow_up_action_items(
        *,
        meetings(id, meeting_type, meeting_date),
        action_item_contacts(contact_id, contacts(id, name))
      )
    `)
    .eq("contact_id", contactId)
    .not("follow_up_action_items", "is", null);

  if (error) throw error;
  const items = (data || [])
    .map((row) => row.follow_up_action_items)
    .filter((item): item is NonNullable<typeof item> => item != null && item.is_completed)
    .sort((a, b) => {
      if (!a.completed_at || !b.completed_at) return 0;
      return new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime();
    });
  return items;
}

/**
 * Replace all contacts for an action item (delete-all-then-reinsert).
 * Used when editing an action item's assigned contacts.
 *
 * @param actionItemId - The action item's ID
 * @param contactIds - New array of contact IDs
 * @throws Error if operation fails
 */
export async function replaceContactsForActionItem(actionItemId: number, contactIds: number[]) {
  // Delete existing
  const { error: delError } = await db()
    .from("action_item_contacts")
    .delete()
    .eq("action_item_id", actionItemId);
  if (delError) throw delError;

  // Insert new
  if (contactIds.length > 0) {
    const { error: insError } = await db()
      .from("action_item_contacts")
      .insert(contactIds.map((cid) => ({ action_item_id: actionItemId, contact_id: cid })));
    if (insError) throw insError;
  }
}

/**
 * Delete an action item permanently.
 * Junction table rows (action_item_contacts) are cascade-deleted.
 *
 * @param id - The action item's ID
 * @throws Error if deletion fails
 */
export async function deleteActionItem(id: number) {
  const { error } = await db()
    .from("follow_up_action_items")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Find the user's open seeded extension-onboarding to-do (CAR-68). Fallback
 * for retiring/deleting the row when the flow modal was opened without an
 * explicit action-item id. must(): an errored lookup must not read as
 * "no open to-do" — both callers catch and leave the row, which is the
 * intended failure mode.
 */
export async function getOnboardingActionItemId(userId: string): Promise<number | null> {
  const data = must(
    await db()
      .from("follow_up_action_items")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "onboarding")
      .eq("is_completed", false)
      .limit(1)
      .maybeSingle(),
  );
  return data?.id ?? null;
}

/**
 * Update an existing action item
 *
 * @param id - The action item's ID
 * @param updates - Partial action item data to update
 * @returns Promise<ActionItem> - The updated action item
 * @throws Error if update fails
 */
export async function updateActionItem(
  id: number,
  updates: Database["public"]["Tables"]["follow_up_action_items"]["Update"]
) {
  const { data, error } = await db()
    .from("follow_up_action_items")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Snooze an action item until a given time.
 */
export async function snoozeActionItem(id: number, until: string) {
  const { error } = await db()
    .from("follow_up_action_items")
    .update({ snoozed_until: until })
    .eq("id", id);
  if (error) throw error;
}
