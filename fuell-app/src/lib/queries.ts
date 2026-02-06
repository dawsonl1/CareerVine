/**
 * Database query functions for the Networking Helper app
 * 
 * This file contains all the database operations using the Supabase client.
 * Each function is typed using the Database types for type safety.
 * 
 * Key patterns:
 * - All functions are async and return promises
 * - Functions throw errors on failure (caller should handle)
 * - Use select() with joins to fetch related data efficiently
 * - Row Level Security (RLS) ensures users can only access their own data
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { Database } from "@/lib/database.types";

// Create a single Supabase client instance for browser-side operations
const supabase = createSupabaseBrowserClient();

/**
 * Fetch all contacts for a user with their related data
 * 
 * This query uses Supabase's join syntax to fetch:
 * - Contact details
 * - Email addresses (multiple per contact)
 * - Phone numbers (multiple per contact)
 * - Employment history with company details
 * - Education history with school details
 * - Tags applied to the contact
 * 
 * @param userId - The user's ID from auth.users
 * @returns Promise<Contact[]> - Array of contacts with all related data
 * @throws Error if query fails
 */
export async function getContacts(userId: string) {
  const { data, error } = await supabase
    .from("contacts")
    .select(`
      *,
      contact_emails(*),
      contact_phones(*),
      contact_companies(
        *,
        companies(*)
      ),
      contact_schools(
        *,
        schools(*)
      ),
      contact_tags(
        *,
        tags(*)
      )
    `)
    .eq("user_id", userId)  // RLS ensures users can only see their own contacts
    .order("name");         // Sort alphabetically by name

  if (error) throw error;
  return data;
}

/**
 * Create a new contact for the authenticated user
 * 
 * @param contact - Contact data matching the contacts table schema (without id)
 * @returns Promise<Contact> - The created contact with generated id
 * @throws Error if creation fails
 */
export async function createContact(
  contact: Database["public"]["Tables"]["contacts"]["Insert"]
) {
  const { data, error } = await supabase
    .from("contacts")
    .insert(contact)
    .select()
    .single();  // Return the single created record

  if (error) throw error;
  return data;
}

/**
 * Update an existing contact
 * 
 * @param id - The contact's ID
 * @param updates - Partial contact data to update
 * @returns Promise<Contact> - The updated contact
 * @throws Error if update fails
 */
export async function updateContact(
  id: number,
  updates: Database["public"]["Tables"]["contacts"]["Update"]
) {
  const { data, error } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Delete a contact and all related data
 * 
 * Note: Due to foreign key constraints with ON DELETE CASCADE,
 * this will automatically delete:
 * - Contact emails
 * - Contact phones
 * - Contact company relationships
 * - Contact school relationships
 * - Contact tag relationships
 * - Contact attachments
 * 
 * @param id - The contact's ID
 * @throws Error if deletion fails
 */
export async function deleteContact(id: number) {
  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

/**
 * Fetch all meetings for a user with attendee information
 * 
 * @param userId - The user's ID
 * @returns Promise<Meeting[]> - Array of meetings with contact attendees
 * @throws Error if query fails
 */
export async function getMeetings(userId: string) {
  const { data, error } = await supabase
    .from("meetings")
    .select(`
      *,
      meeting_contacts(
        *,
        contacts(*)
      )
    `)
    .eq("user_id", userId)
    .order("meeting_date", { ascending: false });  // Most recent first

  if (error) throw error;
  return data;
}

/**
 * Create a new meeting
 * 
 * @param meeting - Meeting data matching the meetings table schema (without id)
 * @returns Promise<Meeting> - The created meeting with generated id
 * @throws Error if creation fails
 */
export async function createMeeting(
  meeting: Database["public"]["Tables"]["meetings"]["Insert"]
) {
  const { data, error } = await supabase
    .from("meetings")
    .insert(meeting)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch all interactions for a specific contact
 * 
 * @param contactId - The contact's ID
 * @returns Promise<Interaction[]> - Array of interactions sorted by date (most recent first)
 * @throws Error if query fails
 */
export async function getInteractions(contactId: number) {
  const { data, error } = await supabase
    .from("interactions")
    .select("*")
    .eq("contact_id", contactId)
    .order("interaction_date", { ascending: false });

  if (error) throw error;
  return data;
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
  const { data, error } = await supabase
    .from("interactions")
    .insert(interaction)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch all tags for a user
 * 
 * @param userId - The user's ID
 * @returns Promise<Tag[]> - Array of tags sorted alphabetically
 * @throws Error if query fails
 */
export async function getTags(userId: string) {
  const { data, error } = await supabase
    .from("tags")
    .select("*")
    .eq("user_id", userId)
    .order("name");

  if (error) throw error;
  return data;
}

/**
 * Create a new tag for a user
 * 
 * @param tag - Tag data matching the tags table schema (without id)
 * @returns Promise<Tag> - The created tag with generated id
 * @throws Error if creation fails
 */
export async function createTag(
  tag: Database["public"]["Tables"]["tags"]["Insert"]
) {
  const { data, error } = await supabase
    .from("tags")
    .insert(tag)
    .select()
    .single();

  if (error) throw error;
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
  const { data, error } = await supabase
    .from("follow_up_action_items")
    .select(`
      *,
      contacts(*)
    `)
    .eq("user_id", userId)
    .eq("is_completed", false)  // Only fetch incomplete items
    .order("due_at", { ascending: true, nullsFirst: false });  // Earliest due date first

  if (error) throw error;
  return data;
}
