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
import { RECENTLY_ADDED_DAYS, SUGGESTION_COOLDOWN_DAYS } from "@/lib/constants";
import { findOrCreateCompany as findOrCreateCompanyShared } from "@/lib/company-helpers";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { validateContactPhotoFile } from "@/lib/contact-photo";

// Create a single Supabase client instance for browser-side operations
const supabase = createSupabaseBrowserClient();

// ── Shared helpers ──

/** Get the ISO cutoff string for the "Recently Added" window */
function getRecentCutoff(): string {
  const d = new Date();
  d.setDate(d.getDate() - RECENTLY_ADDED_DAYS);
  return d.toISOString();
}

/** Get a suggestion cooldown timestamp (now + SUGGESTION_COOLDOWN_DAYS) */
function getSuggestionCooldownTimestamp(): string {
  const d = new Date();
  d.setDate(d.getDate() + SUGGESTION_COOLDOWN_DAYS);
  return d.toISOString();
}

/**
 * Build a map of contact_id → last touch date string.
 * Shared across multiple queries that need last-touch data.
 */
async function buildLastTouchMap(contactIds: number[]): Promise<Map<number, string>> {
  if (contactIds.length === 0) return new Map();

  const [{ data: meetingLinks }, { data: interactions }] = await Promise.all([
    supabase
      .from("meeting_contacts")
      .select("contact_id, meetings(meeting_date)")
      .in("contact_id", contactIds),
    supabase
      .from("interactions")
      .select("contact_id, interaction_date")
      .in("contact_id", contactIds),
  ]);

  const map = new Map<number, string>();
  if (meetingLinks) {
    for (const ml of meetingLinks as unknown as { contact_id: number; meetings: { meeting_date: string } }[]) {
      const date = ml.meetings?.meeting_date;
      if (!date) continue;
      const prev = map.get(ml.contact_id);
      if (!prev || date > prev) map.set(ml.contact_id, date);
    }
  }
  if (interactions) {
    for (const i of interactions) {
      const date = i.interaction_date;
      if (!date) continue;
      const prev = map.get(i.contact_id);
      if (!prev || date > prev) map.set(i.contact_id, date);
    }
  }
  return map;
}

/**
 * Build a lookup map of email address → contact info.
 * Used to match calendar event attendees to known contacts.
 */
export async function getContactEmailLookup(userId: string) {
  const { data, error } = await supabase
    .from("contact_emails")
    .select("email, contact_id, contacts!inner(id, name, photo_url, user_id)")
    .eq("contacts.user_id", userId);
  if (error) throw error;

  const map = new Map<string, { id: number; name: string; photo_url: string | null }>();
  if (data) {
    for (const row of data as unknown as { email: string; contact_id: number; contacts: { id: number; name: string; photo_url: string | null } }[]) {
      if (row.email && row.contacts) {
        map.set(row.email.toLowerCase(), {
          id: row.contacts.id,
          name: row.contacts.name,
          photo_url: row.contacts.photo_url,
        });
      }
    }
  }
  return map;
}

// ── Query functions ──

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
// The joined column set every contact-list query pulls. Extracted so the
// atomic and streaming fetchers stay in lockstep (identical row shape).
const CONTACTS_SELECT = `
  *,
  locations(*),
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
`;

export async function getContacts(
  userId: string,
  opts: { networkStatuses?: Array<"active" | "prospect" | "bench"> } = {},
) {
  // Default excludes bench: dormant imported data must not appear in
  // pickers or general lists — only explicit views opt in (plan 24).
  const statuses = opts.networkStatuses ?? ["active", "prospect"];

  // Paginate: bulk imports push contact counts past PostgREST's row cap,
  // and the old limit(500) silently truncated.
  const PAGE = 1000;
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACTS_SELECT)
      .eq("user_id", userId)
      .in("network_status", statuses)
      .order("name")
      .range(from, from + PAGE - 1);

    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

/**
 * Streaming variant of {@link getContacts}: fetches contacts in ascending
 * name order and invokes `onPage` with each page as it arrives, so the caller
 * can paint the first rows without waiting for the full result set.
 *
 * The first page is deliberately small (`FIRST_PAGE`) for a fast first paint;
 * subsequent pages are large to minimise round-trips on big networks. Pages
 * are contiguous ranges over a stable `order("name")`, so appending them in
 * call order yields the same name-sorted list `getContacts` returns.
 *
 * @returns the full accumulated array (same shape as getContacts).
 */
export async function getContactsStreamed(
  userId: string,
  statuses: Array<"active" | "prospect" | "bench">,
  onPage: (rows: unknown[]) => void,
) {
  const FIRST_PAGE = 50;
  const REST_PAGE = 1000;
  const all: unknown[] = [];
  let from = 0;
  let size = FIRST_PAGE;
  for (;;) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACTS_SELECT)
      .eq("user_id", userId)
      .in("network_status", statuses)
      .order("name")
      .range(from, from + size - 1);

    if (error) throw error;
    const rows = data ?? [];
    if (rows.length) {
      all.push(...rows);
      onPage(rows);
    }
    if (rows.length < size) break;
    from += size;
    size = REST_PAGE;
  }
  return all;
}

/**
 * Fetch a single contact by ID with all related data (same shape as getContacts).
 */
export async function getContactById(contactId: number, userId: string) {
  const { data, error } = await supabase
    .from("contacts")
    .select(`
      *,
      locations(*),
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
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

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
 * Append a note to a contact's existing notes, separated by newlines.
 */
export async function appendContactNote(contactId: number, note: string) {
  const { error } = await supabase.rpc("append_contact_note", {
    p_contact_id: contactId,
    p_note: note,
  });
  if (error) throw error;
}

/**
 * Contact ids (from the given set) with an unactioned company-change event —
 * the plan-29 Q5 bench promote-hint: a bench contact who just moved into a
 * target company is worth a look. RLS scopes to the current user's rows.
 */
export async function getFreshJobChangeContactIds(contactIds: number[]): Promise<Set<number>> {
  if (contactIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("contact_change_events")
    .select("contact_id")
    .eq("type", "company_change")
    .eq("status", "new")
    .in("contact_id", contactIds);
  if (error) throw error;
  return new Set(((data as { contact_id: number }[] | null) ?? []).map((r) => r.contact_id));
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
  // Photo cleanup goes through the photo API route (R2 credentials are
  // server-only) and must run while the row still exists — the route
  // verifies ownership against it. Best-effort; never blocks deletion.
  try {
    await fetch(`/api/contacts/${id}/photo`, { method: "DELETE" });
  } catch (err) {
    console.warn(`[deleteContact] Photo cleanup failed for contact ${id}:`, err);
  }

  // Delete the contact and return tombstone fields (single round-trip)
  const { data: contact, error } = await supabase
    .from("contacts")
    .delete()
    .eq("id", id)
    .select("user_id, linkedin_url, import_source")
    .single();

  if (error) throw error;

  // Imported contacts get a suppression tombstone so background re-imports
  // (pipeline tranches, bundle syncs) can't silently resurrect a contact
  // the user deleted. Manual contacts skip this — nothing re-imports them,
  // and a tombstone would block a future intentional import of the person.
  if (contact?.import_source && contact.linkedin_url && contact.user_id) {
    const canonical = canonicalizeLinkedinUrl(contact.linkedin_url);
    if (canonical) {
      // A surviving duplicate contact with the same URL still wants import
      // refreshes — suppressing it would silently freeze that contact.
      const { data: survivor } = await supabase
        .from("contacts")
        .select("id")
        .eq("user_id", contact.user_id)
        .eq("linkedin_url", canonical)
        .limit(1)
        .maybeSingle();
      if (!survivor) {
        const { error: tombstoneError } = await supabase
          .from("suppressed_imports")
          .upsert(
            { user_id: contact.user_id, linkedin_url: canonical },
            { onConflict: "user_id,linkedin_url", ignoreDuplicates: true },
          );
        if (tombstoneError) {
          console.warn(`[deleteContact] Tombstone write failed for contact ${id}:`, tombstoneError);
        }
      }
    }
  }

}

/**
 * Upload a contact photo. Goes through the photo API route, which
 * thumbnails the image and stores it in R2 (credentials are server-only).
 * Returns the new photo URL.
 */
export async function uploadContactPhoto(_userId: string, contactId: number, file: File) {
  const validationError = validateContactPhotoFile(file);
  if (validationError) throw new Error(validationError);

  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/contacts/${contactId}/photo`, { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { photoUrl?: string; error?: string } | null;
  if (!res.ok || !body?.photoUrl) {
    throw new Error(body?.error || "Failed to upload photo");
  }
  return body.photoUrl;
}

/**
 * Remove a contact photo (R2 object or legacy Supabase object) and clear
 * the contact's photo_url.
 */
export async function removeContactPhoto(_userId: string, contactId: number) {
  const res = await fetch(`/api/contacts/${contactId}/photo`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || "Failed to remove photo");
  }
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
    .order("meeting_date", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data;
}

/**
 * Fetch meetings for a specific contact via the meeting_contacts join
 * 
 * @param contactId - The contact's ID
 * @returns Promise<Meeting[]> - Array of meetings sorted by date (most recent first)
 * @throws Error if query fails
 */
export async function getMeetingsForContact(contactId: number) {
  const { data, error } = await supabase
    .from("meeting_contacts")
    .select(`
      meetings(
        id,
        meeting_date,
        meeting_type,
        title,
        notes,
        private_notes,
        calendar_description,
        transcript
      )
    `)
    .eq("contact_id", contactId);

  if (error) throw error;
  type MeetingRow = { id: number; meeting_date: string; meeting_type: string; title: string | null; notes: string | null; private_notes: string | null; calendar_description: string | null; transcript: string | null };
  // Flatten: Supabase may return meetings as object or array depending on relation
  const meetings: MeetingRow[] = [];
  for (const row of data || []) {
    const m = (row as unknown as { meetings: MeetingRow | MeetingRow[] | null }).meetings;
    if (!m) continue;
    if (Array.isArray(m)) meetings.push(...m);
    else meetings.push(m);
  }
  meetings.sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime());
  return meetings;
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
 * Update an existing meeting
 * 
 * @param id - The meeting's ID
 * @param updates - Partial meeting data to update
 * @returns Promise<Meeting> - The updated meeting
 * @throws Error if update fails
 */
export async function updateMeeting(
  id: number,
  updates: Database["public"]["Tables"]["meetings"]["Update"]
) {
  const { data, error } = await supabase
    .from("meetings")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Delete a meeting and its associated meeting_contacts rows
 *
 * @param id - The meeting's ID
 * @throws Error if operation fails
 */
export async function deleteMeeting(id: number) {
  // Delete associated contacts first
  const { error: mcError } = await supabase
    .from("meeting_contacts")
    .delete()
    .eq("meeting_id", id);
  if (mcError) throw mcError;

  const { error } = await supabase
    .from("meetings")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Replace all contacts for a meeting (delete existing, insert new)
 *
 * @param meetingId - The meeting's ID
 * @param contactIds - New array of contact IDs
 * @throws Error if operation fails
 */
export async function replaceContactsForMeeting(meetingId: number, contactIds: number[]) {
  // Delete existing links
  const { error: delError } = await supabase
    .from("meeting_contacts")
    .delete()
    .eq("meeting_id", meetingId);
  if (delError) throw delError;

  // Insert new links
  if (contactIds.length > 0) {
    const rows = contactIds.map((contact_id) => ({ meeting_id: meetingId, contact_id }));
    const { error: insError } = await supabase.from("meeting_contacts").insert(rows);
    if (insError) throw insError;
    await activateContacts(contactIds);
  }
}

/**
 * Link one or more contacts to a meeting via the meeting_contacts join table
 * 
 * @param meetingId - The meeting's ID
 * @param contactIds - Array of contact IDs to link
 * @throws Error if insertion fails
 */
export async function addContactsToMeeting(meetingId: number, contactIds: number[]) {
  if (contactIds.length === 0) return;
  const rows = contactIds.map((contact_id) => ({ meeting_id: meetingId, contact_id }));
  const { error } = await supabase.from("meeting_contacts").insert(rows);
  if (error) throw error;
  await activateContacts(contactIds);
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
 * Get all interactions for a user (across all contacts), with contact name.
 * Two-step query: first fetches the user's contact IDs, then fetches
 * interactions for those contacts with a join on contacts(id, name).
 *
 * @param userId - The user's ID from auth.users
 * @returns Promise<Interaction[]> - Array of interactions with contact info, sorted by date desc
 * @throws Error if query fails
 */
export async function getAllInteractions(userId: string) {
  // Single query using an inner join on contacts — RLS on contacts ensures user scoping
  const { data, error } = await supabase
    .from("interactions")
    .select("*, contacts!inner(id, name)")
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
  const { data, error } = await supabase
    .from("interactions")
    .insert(interaction)
    .select()
    .single();

  if (error) throw error;
  await activateContacts([interaction.contact_id]);
  return data;
}

/**
 * Provenance for an email address the user is about to send to —
 * powers the compose modal's pattern-guessed / bounced warnings.
 */
export async function getEmailProvenance(address: string) {
  const clean = address.trim().toLowerCase();
  if (!clean) return null;
  const { data } = await supabase
    .from("contact_emails")
    .select("id, source, bounced_at")
    .eq("email", clean)
    .limit(1);
  return (data?.[0] as { id: number; source: string; bounced_at: string | null } | undefined) ?? null;
}

/** Flip a pattern-guessed address to verified (e.g. after a reply). */
export async function markEmailVerified(emailId: number) {
  const { error } = await supabase
    .from("contact_emails")
    .update({ source: "verified" })
    .eq("id", emailId);
  if (error) throw error;
}

/**
 * First real touch (interaction, meeting, outbound email) graduates
 * imported prospects/bench contacts into the active network (plan 24
 * tier transition). No-op for contacts already active.
 */
export async function activateContacts(contactIds: number[]) {
  if (contactIds.length === 0) return;
  const { error } = await supabase
    .from("contacts")
    .update({ network_status: "active" })
    .in("id", contactIds)
    .in("network_status", ["prospect", "bench"]);
  if (error) console.error("Failed to activate contacts:", error);
}

/**
 * Fast per-tier contact counts for the network tier toggle chips —
 * head-only count queries so the numbers arrive long before the full
 * contact payload finishes loading.
 */
export async function getNetworkTierCounts(userId: string) {
  const tiers = ["active", "prospect", "bench"] as const;
  const results = await Promise.all(
    tiers.map((tier) =>
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("network_status", tier)
    )
  );
  return {
    active: results[0].count ?? 0,
    prospect: results[1].count ?? 0,
    bench: results[2].count ?? 0,
  };
}

/**
 * Manually promote a single prospect/bench contact into the active
 * network (the "Add to network" button). Unlike the fire-and-forget
 * bulk activateContacts(), this throws so the UI can surface failures.
 */
export async function activateContact(contactId: number) {
  const { error } = await supabase
    .from("contacts")
    .update({ network_status: "active" })
    .eq("id", contactId);
  if (error) throw error;
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
 * Find or create a company by name (upsert pattern).
 * Delegates to the consolidated helper (case-insensitive escaped-ilike
 * match, race-safe insert) so the browser and server paths behave
 * identically.
 *
 * @param name - Company name to find or create
 * @returns Promise<Company> - The existing or newly created company
 * @throws Error if creation fails
 */
export async function findOrCreateCompany(name: string) {
  return await findOrCreateCompanyShared(supabase, { name });
}

/**
 * Link a company to a contact with job details (title, is_current)
 *
 * @param contactCompany - Junction table row data
 * @returns Promise<ContactCompany> - The created link
 * @throws Error if insertion fails
 */
export async function addCompanyToContact(contactCompany: Database["public"]["Tables"]["contact_companies"]["Insert"]) {
  const { data, error } = await supabase
    .from("contact_companies")
    .insert(contactCompany)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Remove all company links for a contact (used before re-inserting on edit)
 *
 * @param contactId - The contact's ID
 * @throws Error if deletion fails
 */
export async function removeCompaniesFromContact(contactId: number) {
  const { error } = await supabase
    .from("contact_companies")
    .delete()
    .eq("contact_id", contactId);
  if (error) throw error;
}

/**
 * Find or create a school by name (upsert pattern)
 * Checks for existing school first to avoid duplicate key errors.
 *
 * @param name - School name to find or create
 * @returns Promise<School> - The existing or newly created school
 * @throws Error if creation fails
 */
export async function findOrCreateSchool(name: string) {
  // Try to find existing
  const { data: existing } = await supabase
    .from("schools")
    .select("*")
    .eq("name", name)
    .maybeSingle();
  if (existing) return existing;

  // Create new
  const { data, error } = await supabase
    .from("schools")
    .insert({ name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Find or create a normalized location entry
 * Checks for existing location by city+state+country to avoid duplicates.
 *
 * @param location - Object with city, state, country
 * @returns Promise<Location> - The existing or newly created location
 * @throws Error if creation fails
 */
export async function findOrCreateLocation(location: { city: string | null; state: string | null; country: string }) {
  // Try to find existing with exact match
  let query = supabase.from("locations").select("*");
  
  if (location.city) {
    query = query.eq("city", location.city);
  } else {
    query = query.is("city", null);
  }
  
  if (location.state) {
    query = query.eq("state", location.state);
  } else {
    query = query.is("state", null);
  }
  
  query = query.eq("country", location.country);
  
  const { data: existing } = await query.maybeSingle();
  if (existing) return existing;

  // Create new
  const { data, error } = await supabase
    .from("locations")
    .insert({
      city: location.city,
      state: location.state,
      country: location.country,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Link a school to a contact with education details (degree, field_of_study, etc.)
 *
 * @param contactSchool - Junction table row data
 * @returns Promise<ContactSchool> - The created link
 * @throws Error if insertion fails
 */
export async function addSchoolToContact(contactSchool: Database["public"]["Tables"]["contact_schools"]["Insert"]) {
  const { data, error } = await supabase
    .from("contact_schools")
    .insert(contactSchool)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Remove all school links for a contact (used before re-inserting on edit)
 *
 * @param contactId - The contact's ID
 * @throws Error if deletion fails
 */
export async function removeSchoolsFromContact(contactId: number) {
  const { error } = await supabase
    .from("contact_schools")
    .delete()
    .eq("contact_id", contactId);
  if (error) throw error;
}

/**
 * Create a follow-up action item with optional multiple contacts
 * 
 * @param actionItem - Action item data (contact_id is kept for legacy compat)
 * @param contactIds - Array of contact IDs to associate
 * @returns Promise<ActionItem> - The created action item
 * @throws Error if creation fails
 */
export async function createActionItem(
  actionItem: Database["public"]["Tables"]["follow_up_action_items"]["Insert"],
  contactIds?: number[],
  client?: typeof supabase
) {
  const db = client ?? supabase;
  const { data, error } = await db
    .from("follow_up_action_items")
    .insert(actionItem)
    .select()
    .single();

  if (error) throw error;

  // Insert into junction table
  const ids = contactIds ?? (actionItem.contact_id ? [actionItem.contact_id] : []);
  if (ids.length > 0) {
    const { error: junctionError } = await db
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
  const { data, error } = await supabase
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
    .order("due_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}

/**
 * Fetch action items linked to a specific meeting
 * 
 * @param meetingId - The meeting's ID
 * @returns Promise<ActionItem[]> - Array of action items with contact info
 * @throws Error if query fails
 */
export async function getActionItemsForMeeting(meetingId: number) {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
    .map((row) => (row as any).follow_up_action_items)
    .filter((item: any) => item && !item.is_completed)
    .sort((a: any, b: any) => {
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
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
    .map((row) => (row as any).follow_up_action_items)
    .filter((item: any) => item && item.is_completed)
    .sort((a: any, b: any) => {
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
  const { error: delError } = await supabase
    .from("action_item_contacts")
    .delete()
    .eq("action_item_id", actionItemId);
  if (delError) throw delError;

  // Insert new
  if (contactIds.length > 0) {
    const { error: insError } = await supabase
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
  const { error } = await supabase
    .from("follow_up_action_items")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Find the user's open seeded extension-onboarding to-do (CAR-68). Fallback
 * for retiring/deleting the row when the flow modal was opened without an
 * explicit action-item id.
 */
export async function getOnboardingActionItemId(userId: string): Promise<number | null> {
  const { data } = await supabase
    .from("follow_up_action_items")
    .select("id")
    .eq("user_id", userId)
    .eq("source", "onboarding")
    .eq("is_completed", false)
    .limit(1)
    .maybeSingle();
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
  const { data, error } = await supabase
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
  const { error } = await supabase
    .from("follow_up_action_items")
    .update({ snoozed_until: until })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Snooze a contact's reach-out / recently-added card until a given time.
 * Also sets suggestion_cooldown_until to 3 weeks from now.
 */
export async function snoozeContact(contactId: number, until: string) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await supabase
    .from("contacts")
    .update({
      reach_out_snoozed_until: until,
      suggestion_cooldown_until: cooldown,
    })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Permanently skip first outreach for a contact.
 * Also sets suggestion_cooldown_until to 3 weeks from now.
 */
export async function skipContactFirstOutreach(contactId: number) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await supabase
    .from("contacts")
    .update({
      first_outreach_skipped: true,
      suggestion_cooldown_until: cooldown,
    })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Set suggestion cooldown on a contact (e.g., after dismissing an AI suggestion).
 */
export async function setSuggestionCooldown(contactId: number) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await supabase
    .from("contacts")
    .update({ suggestion_cooldown_until: cooldown })
    .eq("id", contactId);
  if (error) throw error;
}

// ── Contact Emails ──

export async function addEmailToContact(contactId: number, email: string, isPrimary: boolean) {
  const { data, error } = await supabase
    .from("contact_emails")
    .insert({ contact_id: contactId, email, is_primary: isPrimary })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateContactEmail(id: number, updates: Database["public"]["Tables"]["contact_emails"]["Update"]) {
  const { data, error } = await supabase
    .from("contact_emails")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteContactEmail(id: number) {
  const { error } = await supabase.from("contact_emails").delete().eq("id", id);
  if (error) throw error;
}

export async function removeEmailsFromContact(contactId: number) {
  const { error } = await supabase.from("contact_emails").delete().eq("contact_id", contactId);
  if (error) throw error;
}

// ── Contact Phones ──

export async function addPhoneToContact(contactId: number, phone: string, type: string, isPrimary: boolean) {
  const { data, error } = await supabase
    .from("contact_phones")
    .insert({ contact_id: contactId, phone, type, is_primary: isPrimary })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateContactPhone(id: number, updates: Database["public"]["Tables"]["contact_phones"]["Update"]) {
  const { data, error } = await supabase
    .from("contact_phones")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteContactPhone(id: number) {
  const { error } = await supabase.from("contact_phones").delete().eq("id", id);
  if (error) throw error;
}

export async function removePhonesFromContact(contactId: number) {
  const { error } = await supabase.from("contact_phones").delete().eq("contact_id", contactId);
  if (error) throw error;
}

// ── Tags ──

export async function addTagToContact(contactId: number, tagId: number) {
  const { error } = await supabase.from("contact_tags").insert({ contact_id: contactId, tag_id: tagId });
  if (error) throw error;
}

export async function removeTagFromContact(contactId: number, tagId: number) {
  const { error } = await supabase
    .from("contact_tags")
    .delete()
    .eq("contact_id", contactId)
    .eq("tag_id", tagId);
  if (error) throw error;
}

export async function deleteTag(id: number) {
  const { error } = await supabase.from("tags").delete().eq("id", id);
  if (error) throw error;
}

// ── Interactions CRUD ──

export async function updateInteraction(
  id: number,
  updates: Database["public"]["Tables"]["interactions"]["Update"]
) {
  const { data, error } = await supabase
    .from("interactions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteInteraction(id: number) {
  const { error } = await supabase.from("interactions").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Get all contacts with their last interaction/meeting date for the relationship health grid.
 * Returns a lightweight projection: id, name, industry, last_touch date, and days since last touch.
 *
 * @param userId - The user's ID
 * @returns Promise<ContactHealth[]> - All contacts with recency data
 */
export async function getContactsWithLastTouch(userId: string) {
  const { data: contacts, error: cErr } = await supabase
    .from("contacts")
    .select("id, name, industry, follow_up_frequency_days, photo_url")
    .eq("user_id", userId)
    .order("name")
    .limit(500);
  if (cErr) throw cErr;
  if (!contacts || contacts.length === 0) return [];

  const contactIds = contacts.map((c) => c.id);

  // Get latest meeting date per contact
  const { data: meetingLinks } = await supabase
    .from("meeting_contacts")
    .select("contact_id, meetings(meeting_date)")
    .in("contact_id", contactIds);

  // Get latest interaction date per contact
  const { data: interactions } = await supabase
    .from("interactions")
    .select("contact_id, interaction_date")
    .in("contact_id", contactIds);

  const lastTouchMap = new Map<number, string>();

  if (meetingLinks) {
    for (const ml of meetingLinks as unknown as { contact_id: number; meetings: { meeting_date: string } }[]) {
      const date = ml.meetings?.meeting_date;
      if (!date) continue;
      const prev = lastTouchMap.get(ml.contact_id);
      if (!prev || date > prev) lastTouchMap.set(ml.contact_id, date);
    }
  }

  if (interactions) {
    for (const i of interactions) {
      const date = i.interaction_date;
      if (!date) continue;
      const prev = lastTouchMap.get(i.contact_id);
      if (!prev || date > prev) lastTouchMap.set(i.contact_id, date);
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return contacts.map((c) => {
    const lastTouch = lastTouchMap.get(c.id) || null;
    const daysSinceTouch = lastTouch
      ? Math.floor((today.getTime() - new Date(lastTouch).getTime()) / (1000 * 60 * 60 * 24))
      : null; // null means never contacted
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      photo_url: c.photo_url,
      follow_up_frequency_days: c.follow_up_frequency_days,
      last_touch: lastTouch,
      days_since_touch: daysSinceTouch,
    };
  });
}

/**
 * Get contacts that are due (or overdue) for follow-up.
 * Returns contacts with follow_up_frequency_days set, enriched with
 * their most recent meeting and interaction dates so the caller can
 * compute how many days overdue they are.
 */
export async function getContactsDueForFollowUp(userId: string) {
  const now = new Date().toISOString();
  const recentCutoff = getRecentCutoff();

  const { data: contacts, error: cErr } = await supabase
    .from("contacts")
    .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, contact_emails(email)")
    .eq("user_id", userId)
    .eq("network_status", "active") // imported prospects/bench never generate follow-up nags
    .or(`reach_out_snoozed_until.is.null,reach_out_snoozed_until.lt.${now}`)
    .order("name");
  if (cErr) throw cErr;
  if (!contacts || contacts.length === 0) return [];

  const contactIds = contacts.map((c) => c.id);
  const lastTouchMap = await buildLastTouchMap(contactIds);

  // 5. Filter to contacts that are due
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return contacts
    .map((c) => {
      const lastTouch = lastTouchMap.get(c.id);
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const freqDays = c.follow_up_frequency_days;
      const neverContacted = !lastTouchDate;
      const noCadence = !freqDays;

      // Exclude never-contacted contacts that are still in the Recently Added window (< 7 days)
      // or that have been skipped
      const isRecent = c.created_at >= recentCutoff;
      if (neverContacted && (isRecent || c.first_outreach_skipped)) {
        return null;
      }

      // Contacts with no cadence: include if they've been contacted before or are past 7 days
      // They have no overdue calculation — they just appear with days_overdue = 0
      if (noCadence) {
        // Only include if: contacted before, or past 7 days and never contacted
        if (!neverContacted || !isRecent) {
          return {
            id: c.id,
            name: c.name,
            industry: c.industry,
            photo_url: c.photo_url,
            follow_up_frequency_days: 0,
            last_touch: lastTouch || null,
            days_overdue: 0,
            never_contacted: neverContacted,
            no_cadence: true,
            emails: ((c as any).contact_emails || []).map((e: { email: string }) => e.email) as string[],
          };
        }
        return null;
      }

      let daysOverdue: number;
      if (neverContacted) {
        const createdDate = new Date(c.created_at);
        const dueDate = new Date(createdDate);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        const dueDate = new Date(lastTouchDate);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      }

      if (daysOverdue < 0) return null; // Not yet due

      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        photo_url: c.photo_url,
        follow_up_frequency_days: freqDays,
        last_touch: lastTouch || null,
        days_overdue: daysOverdue,
        never_contacted: neverContacted,
        no_cadence: false,
        emails: ((c as any).contact_emails || []).map((e: { email: string }) => e.email) as string[],
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => {
      // No-cadence contacts sort to the end
      if (a.no_cadence && !b.no_cadence) return 1;
      if (!a.no_cadence && b.no_cadence) return -1;
      return b.days_overdue - a.days_overdue;
    });
}

/**
 * Get the user's profile from the public.users table.
 *
 * @param userId - The user's ID (UUID from auth.users)
 * @returns Promise<UserRow> - The user's profile data
 * @throws Error if query fails or user not found
 */
export async function getUserProfile(userId: string) {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  const { error } = await supabase
    .from("users")
    .update({ dismissed_getting_started: ids })
    .eq("id", userId);
  if (error) throw error;
}

// ═══════════════════════════════════════════════════════════
// Attachments
// ═══════════════════════════════════════════════════════════

/**
 * Upload a file to Supabase Storage and create an attachment record.
 * Files are stored at: attachments/{userId}/{uuid}_{filename}
 *
 * @param userId - The user's ID (used as folder name for RLS)
 * @param file - The File object to upload
 * @returns Promise<Attachment row> - The created attachment record
 * @throws Error if upload or insert fails
 */
export async function uploadAttachment(userId: string, file: File) {
  const uuid = crypto.randomUUID();
  const objectPath = `${userId}/${uuid}_${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("attachments")
    .upload(objectPath, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("attachments")
    .insert({
      user_id: userId,
      bucket: "attachments",
      object_path: objectPath,
      file_name: file.name,
      content_type: file.type || null,
      file_size_bytes: file.size,
      is_public: false,
      notes: null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Link an attachment to a contact.
 *
 * @param contactId - The contact's ID
 * @param attachmentId - The attachment's ID
 * @throws Error if insertion fails
 */
export async function addAttachmentToContact(contactId: number, attachmentId: number) {
  const { error } = await supabase
    .from("contact_attachments")
    .insert({ contact_id: contactId, attachment_id: attachmentId });
  if (error) throw error;
}

/**
 * Link an attachment to a meeting.
 *
 * @param meetingId - The meeting's ID
 * @param attachmentId - The attachment's ID
 * @throws Error if insertion fails
 */
export async function addAttachmentToMeeting(meetingId: number, attachmentId: number) {
  const { error } = await supabase
    .from("meeting_attachments")
    .insert({ meeting_id: meetingId, attachment_id: attachmentId });
  if (error) throw error;
}

/**
 * Get all attachments for a contact.
 *
 * @param contactId - The contact's ID
 * @returns Promise<Attachment[]> - Array of attachment records
 * @throws Error if query fails
 */
export async function getAttachmentsForContact(contactId: number) {
  const { data, error } = await supabase
    .from("contact_attachments")
    .select("attachment_id, attachments(*)")
    .eq("contact_id", contactId);
  if (error) throw error;
  return (data || []).map((row: any) => row.attachments).filter(Boolean);
}

/**
 * Get all attachments for a meeting.
 *
 * @param meetingId - The meeting's ID
 * @returns Promise<Attachment[]> - Array of attachment records
 * @throws Error if query fails
 */
export async function getAttachmentsForMeeting(meetingId: number) {
  const { data, error } = await supabase
    .from("meeting_attachments")
    .select("attachment_id, attachments(*)")
    .eq("meeting_id", meetingId);
  if (error) throw error;
  return (data || []).map((row: any) => row.attachments).filter(Boolean);
}

/**
 * Get a temporary signed URL for downloading/viewing an attachment.
 *
 * @param objectPath - The storage object path (from attachments.object_path)
 * @param expiresIn - Seconds until the URL expires (default 3600 = 1 hour)
 * @returns Promise<string> - Signed URL
 * @throws Error if signing fails
 */
export async function getAttachmentUrl(objectPath: string, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from("attachments")
    .createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

// ═══════════════════════════════════════════════════════════
// Gmail
// ═══════════════════════════════════════════════════════════

export async function getGmailConnection(userId: string) {
  const { data, error } = await supabase
    .from("gmail_connections")
    .select("id, gmail_address, last_gmail_sync_at, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEmailsForContact(userId: string, contactId: number) {
  const { data, error } = await supabase
    .from("email_messages")
    .select("*")
    .eq("user_id", userId)
    .eq("matched_contact_id", contactId)
    .order("date", { ascending: false })
    .limit(500);
  if (error) throw error;
  return data || [];
}

export async function getFollowUpsForThread(userId: string, threadId: string) {
  const { data, error } = await supabase
    .from("email_follow_ups")
    .select("*, email_follow_up_messages(*)")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getActiveFollowUps(userId: string) {
  const { data, error } = await supabase
    .from("email_follow_ups")
    .select("*, email_follow_up_messages(*)")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Delete an attachment: removes the storage object, the attachment row,
 * and any junction table links.
 *
 * @param attachmentId - The attachment's ID
 * @param objectPath - The storage object path to delete
 * @throws Error if any step fails
 */
export async function deleteAttachment(attachmentId: number, objectPath: string) {
  // Remove from storage
  const { error: storageError } = await supabase.storage
    .from("attachments")
    .remove([objectPath]);
  if (storageError) throw storageError;

  // Remove junction table links
  await supabase.from("contact_attachments").delete().eq("attachment_id", attachmentId);
  await supabase.from("meeting_attachments").delete().eq("attachment_id", attachmentId);
  await supabase.from("interaction_attachments").delete().eq("attachment_id", attachmentId);

  // Remove attachment record
  const { error } = await supabase.from("attachments").delete().eq("id", attachmentId);
  if (error) throw error;
}

// ═══════════════════════════════════════════════════════════
// Transcript Segments
// ═══════════════════════════════════════════════════════════

/**
 * Atomically replace transcript segments for a meeting.
 * Uses a Postgres function to delete+insert in a single transaction,
 * preventing data loss if the insert fails.
 */
export async function createTranscriptSegments(
  meetingId: number,
  segments: { speaker_label: string; contact_id?: number | null; started_at?: number | null; ended_at?: number | null; content: string }[],
) {
  if (segments.length === 0) {
    await supabase.from("transcript_segments").delete().eq("meeting_id", meetingId);
    return [];
  }

  const rows = segments.map((s, i) => ({
    ordinal: i,
    speaker_label: s.speaker_label,
    contact_id: s.contact_id ?? null,
    started_at: s.started_at ?? null,
    ended_at: s.ended_at ?? null,
    content: s.content,
  }));

  const { error } = await supabase.rpc("replace_transcript_segments", {
    p_meeting_id: meetingId,
    p_segments: rows,
  });
  if (error) throw error;

  // Return the newly inserted segments
  return getTranscriptSegments(meetingId);
}

/**
 * Get all transcript segments for a meeting, ordered by position.
 */
export async function getTranscriptSegments(meetingId: number) {
  const { data, error } = await supabase
    .from("transcript_segments")
    .select("*, contacts:contact_id(id, name)")
    .eq("meeting_id", meetingId)
    .order("ordinal");
  if (error) throw error;
  return data;
}

/**
 * Update the resolved contact for a single segment.
 */
export async function updateSegmentContact(segmentId: number, contactId: number | null) {
  const { error } = await supabase
    .from("transcript_segments")
    .update({ contact_id: contactId })
    .eq("id", segmentId);
  if (error) throw error;
}

/**
 * Bulk-update contact_id for all segments matching a speaker label in a meeting.
 */
export async function updateSpeakerContact(
  meetingId: number,
  speakerLabel: string,
  contactId: number | null,
) {
  const { error } = await supabase
    .from("transcript_segments")
    .update({ contact_id: contactId })
    .eq("meeting_id", meetingId)
    .eq("speaker_label", speakerLabel);
  if (error) throw error;
}

/**
 * Delete all transcript segments for a meeting.
 */
export async function deleteTranscriptSegments(meetingId: number) {
  const { error } = await supabase
    .from("transcript_segments")
    .delete()
    .eq("meeting_id", meetingId);
  if (error) throw error;
}

// ═══════════════════════════════════════════════════════════════
//  HOME PAGE DATA
// ═══════════════════════════════════════════════════════════════

/**
 * Get contacts created in the last 7 days that have no logged meetings or interactions.
 */
export async function getRecentUncontactedContacts(userId: string) {
  const cutoff = getRecentCutoff();
  const now = new Date().toISOString();

  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id, name, photo_url, industry, created_at, contact_emails(email)")
    .eq("user_id", userId)
    .eq("network_status", "active") // bulk-imported tiers never trigger first-touch prompts
    .eq("first_outreach_skipped", false)
    .or(`reach_out_snoozed_until.is.null,reach_out_snoozed_until.lt.${now}`)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  if (!contacts || contacts.length === 0) return [];

  const contactIds = contacts.map((c) => c.id);

  // Check which contacts have meetings
  const { data: meetingLinks } = await supabase
    .from("meeting_contacts")
    .select("contact_id")
    .in("contact_id", contactIds);

  // Check which contacts have interactions
  const { data: interactionLinks } = await supabase
    .from("interactions")
    .select("contact_id")
    .in("contact_id", contactIds);

  const contacted = new Set<number>();
  if (meetingLinks) meetingLinks.forEach((ml) => contacted.add(ml.contact_id));
  if (interactionLinks) interactionLinks.forEach((i) => contacted.add(i.contact_id));

  return contacts
    .filter((c) => !contacted.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      industry: c.industry,
      created_at: c.created_at,
      emails: (c.contact_emails || []).map((e: { email: string }) => e.email),
    }));
}

/**
 * Combined home page data fetch — loads action items + all contact-derived data
 * in minimal queries. Replaces separate calls to getActionItems, getContactsDueForFollowUp,
 * getContactsWithLastTouch, and getRecentUncontactedContacts.
 *
 * Query breakdown:
 * 1. Action items (1 query)
 * 2. All contacts with emails (1 query)
 * 3. Last-touch map from meeting_contacts + interactions (2 queries in parallel)
 * Total: 4 queries (down from ~10+ when calling functions individually)
 */
export async function getHomeCoreData(userId: string) {
  const now = new Date().toISOString();
  const recentCutoff = getRecentCutoff();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch action items + all contacts in parallel
  const [actionItemsResult, contactsResult] = await Promise.all([
    supabase
      .from("follow_up_action_items")
      .select("*, contacts(*), meetings(*), action_item_contacts(contact_id, contacts(id, name))")
      .eq("user_id", userId)
      .eq("is_completed", false)
      .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("contacts")
      .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, reach_out_snoozed_until, contact_emails(email)")
      .eq("user_id", userId)
      .eq("network_status", "active") // network health + reach-out prompts cover the real network only
      .order("name"),
  ]);

  if (actionItemsResult.error) throw actionItemsResult.error;
  if (contactsResult.error) throw contactsResult.error;

  const actionItems = actionItemsResult.data || [];
  const allContacts = contactsResult.data || [];
  const contactIds = allContacts.map((c) => c.id);

  // Build last-touch map (2 queries in parallel)
  const lastTouchMap = await buildLastTouchMap(contactIds);

  // ── Derive contactHealth (for lastTouchLookup) ──
  const contactHealth = allContacts.map((c) => {
    const lastTouch = lastTouchMap.get(c.id) || null;
    const daysSinceTouch = lastTouch
      ? Math.floor((today.getTime() - new Date(lastTouch).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    return {
      id: c.id,
      name: c.name,
      days_since_touch: daysSinceTouch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    };
  });

  // ── Derive followUps (reach out contacts) ──
  // Filter snoozed contacts for followUps/recentlyAdded (but not contactHealth)
  const isSnoozed = (c: { reach_out_snoozed_until: string | null }) =>
    c.reach_out_snoozed_until && new Date(c.reach_out_snoozed_until) > new Date(now);

  const followUps = allContacts
    .map((c) => {
      if (isSnoozed(c)) return null;

      const lastTouch = lastTouchMap.get(c.id);
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const freqDays = c.follow_up_frequency_days;
      const neverContacted = !lastTouchDate;
      const noCadence = !freqDays;
      const isRecent = c.created_at >= recentCutoff;

      if (neverContacted && (isRecent || c.first_outreach_skipped)) return null;

      if (noCadence) {
        if (!neverContacted || !isRecent) {
          return {
            id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
            follow_up_frequency_days: 0, last_touch: lastTouch || null,
            days_overdue: 0, never_contacted: neverContacted, no_cadence: true,
            emails: ((c as any).contact_emails || []).map((e: { email: string }) => e.email) as string[],
          };
        }
        return null;
      }

      let daysOverdue: number;
      if (neverContacted) {
        const dueDate = new Date(c.created_at);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        const dueDate = new Date(lastTouchDate);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      }
      if (daysOverdue < 0) return null;

      return {
        id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
        follow_up_frequency_days: freqDays, last_touch: lastTouch || null,
        days_overdue: daysOverdue, never_contacted: neverContacted, no_cadence: false,
        emails: ((c as any).contact_emails || []).map((e: { email: string }) => e.email) as string[],
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => {
      if (a.no_cadence && !b.no_cadence) return 1;
      if (!a.no_cadence && b.no_cadence) return -1;
      return b.days_overdue - a.days_overdue;
    });

  // ── Derive recentlyAdded (uncontacted contacts in last 7 days) ──
  const contacted = new Set<number>();
  for (const [id] of lastTouchMap) contacted.add(id);

  const recentlyAdded = allContacts
    .filter((c) => {
      if (isSnoozed(c)) return false;
      if (c.first_outreach_skipped) return false;
      if (c.created_at < recentCutoff) return false;
      if (contacted.has(c.id)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      industry: c.industry,
      created_at: c.created_at,
      emails: ((c as any).contact_emails || []).map((e: { email: string }) => e.email) as string[],
    }));

  return { actionItems, contactHealth, followUps, recentlyAdded };
}

/**
 * Fast count of action list items — fires first on page load so the calendar
 * can predict its height before the full data loads.
 * Returns: action items (non-waiting_on) + contacts with follow-up frequency
 * (upper bound for reach-out) + recently added uncontacted contacts.
 */
export async function getActionListCounts(userId: string) {
  const cutoff = getRecentCutoff();

  const [actionResult, followUpResult, recentResult] = await Promise.all([
    // Count incomplete action items (excluding waiting_on)
    supabase
      .from("follow_up_action_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_completed", false)
      .or("direction.is.null,direction.neq.waiting_on"),

    // Upper bound for reach-out: contacts with a follow-up frequency set
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .not("follow_up_frequency_days", "is", null),

    // Recently added contacts (last 7 days)
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", cutoff),
  ]);

  return {
    actionItems: actionResult.count ?? 0,
    reachOut: followUpResult.count ?? 0,
    recentlyAdded: recentResult.count ?? 0,
  };
}

/**
 * Calculate "Relationships on track" percentage.
 *
 * Denominator: contacts that have been contacted at least once OR
 * are past the 7-day Recently Added window (excluding first_outreach_skipped).
 *
 * Numerator: contacts where days_since_last_touch <= follow_up_frequency_days.
 * Contacts with no cadence set are automatically NOT on track.
 *
 * Returns percentage + breakdown for tooltip.
 */
export async function getRelationshipsOnTrack(userId: string) {
  const recentCutoff = getRecentCutoff();

  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id, follow_up_frequency_days, created_at, first_outreach_skipped")
    .eq("user_id", userId);
  if (error) throw error;
  if (!contacts || contacts.length === 0) {
    return { percentage: 100, onTrack: 0, total: 0, breakdown: { withCadenceOnTrack: 0, withCadenceOverdue: 0, noCadence: 0, neverContactedPast7d: 0 } };
  }

  const contactIds = contacts.map((c) => c.id);
  const lastTouchMap = await buildLastTouchMap(contactIds);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let onTrack = 0;
  let total = 0;
  let withCadenceOnTrack = 0;
  let withCadenceOverdue = 0;
  let noCadence = 0;
  let neverContactedPast7d = 0;

  for (const c of contacts) {
    if (c.first_outreach_skipped) continue;

    const lastTouch = lastTouchMap.get(c.id);
    const hasBeenContacted = !!lastTouch;
    const isRecent = c.created_at >= recentCutoff;

    // Include if: contacted at least once, OR past 7-day window
    if (!hasBeenContacted && isRecent) continue; // Still in Recently Added — skip

    total++;

    if (!hasBeenContacted) {
      // Past 7 days, never contacted
      neverContactedPast7d++;
      if (c.follow_up_frequency_days) {
        // Has cadence — check if overdue from created_at
        const createdDate = new Date(c.created_at);
        const dueDate = new Date(createdDate);
        dueDate.setDate(dueDate.getDate() + c.follow_up_frequency_days);
        if (today <= dueDate) {
          onTrack++;
          withCadenceOnTrack++;
        } else {
          withCadenceOverdue++;
        }
      } else {
        noCadence++;
        // No cadence = not on track
      }
      continue;
    }

    // Has been contacted
    if (!c.follow_up_frequency_days) {
      noCadence++;
      // No cadence = not on track
      continue;
    }

    const lastTouchDate = new Date(lastTouch);
    const daysSince = Math.floor((today.getTime() - lastTouchDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= c.follow_up_frequency_days) {
      onTrack++;
      withCadenceOnTrack++;
    } else {
      withCadenceOverdue++;
    }
  }

  const percentage = total > 0 ? Math.round((onTrack / total) * 100) : 100;

  return {
    percentage,
    onTrack,
    total,
    breakdown: {
      withCadenceOnTrack,
      withCadenceOverdue,
      noCadence,
      neverContactedPast7d,
    },
  };
}

/**
 * Get the user's current networking streak — consecutive days with at least
 * one activity (meeting logged, action item completed, or interaction).
 * Counts backward from yesterday (today is still in progress).
 */
export async function getNetworkingStreak(userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Look back up to 365 days
  const lookback = new Date(today);
  lookback.setDate(lookback.getDate() - 365);
  const lookbackStr = lookback.toISOString().split("T")[0];

  // Get all activity dates
  const [meetingsRes, completedRes, interactionsRes] = await Promise.all([
    supabase
      .from("meetings")
      .select("meeting_date")
      .eq("user_id", userId)
      .gte("meeting_date", lookbackStr),
    supabase
      .from("follow_up_action_items")
      .select("completed_at")
      .eq("user_id", userId)
      .eq("is_completed", true)
      .gte("completed_at", lookback.toISOString()),
    supabase
      .from("interactions")
      .select("interaction_date, contacts!inner()")
      .eq("contacts.user_id", userId)
      .gte("interaction_date", lookbackStr),
  ]);

  const activeDays = new Set<string>();

  if (meetingsRes.data) {
    for (const m of meetingsRes.data) {
      if (m.meeting_date) activeDays.add(m.meeting_date.split("T")[0]);
    }
  }
  if (completedRes.data) {
    for (const a of completedRes.data) {
      if (a.completed_at) activeDays.add(a.completed_at.split("T")[0]);
    }
  }
  if (interactionsRes.data) {
    for (const i of interactionsRes.data) {
      if (i.interaction_date) activeDays.add(i.interaction_date.split("T")[0]);
    }
  }

  // Count consecutive days backward from yesterday
  let streak = 0;
  const checkDate = new Date(today);
  // Include today if there's activity
  const todayStr = today.toISOString().split("T")[0];
  if (activeDays.has(todayStr)) {
    streak = 1;
    checkDate.setDate(checkDate.getDate() - 1);
  } else {
    // Start from yesterday
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const dateStr = checkDate.toISOString().split("T")[0];
    if (activeDays.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { streak };
}

/**
 * Get aggregated home page stats: rolling 7-day window + previous 7 days for trend comparison.
 */
export async function getHomeStats(userId: string) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const currentStr = sevenDaysAgo.toISOString();
  const previousStr = fourteenDaysAgo.toISOString();

  const [
    { count: meetingsCurrent },
    { count: meetingsPrevious },
    { count: pendingItems },
    { count: completedCurrent },
    { count: completedPrevious },
    { count: contactsCurrent },
    { count: contactsPrevious },
    { count: interactionsCurrent },
    { count: interactionsPrevious },
    { count: emailsSentCurrent },
    { count: emailsSentPrevious },
  ] = await Promise.all([
    supabase.from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("meeting_date", currentStr.split("T")[0]),
    supabase.from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("meeting_date", previousStr.split("T")[0]).lt("meeting_date", currentStr.split("T")[0]),
    supabase.from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", false),
    supabase.from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", true).gte("completed_at", currentStr),
    supabase.from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", true).gte("completed_at", previousStr).lt("completed_at", currentStr),
    supabase.from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", currentStr),
    supabase.from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", previousStr).lt("created_at", currentStr),
    supabase.from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).gte("interaction_date", currentStr.split("T")[0]),
    supabase.from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).gte("interaction_date", previousStr.split("T")[0]).lt("interaction_date", currentStr.split("T")[0]),
    supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "outbound").gte("date", currentStr.split("T")[0]),
    supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "outbound").gte("date", previousStr.split("T")[0]).lt("date", currentStr.split("T")[0]),
  ]);

  return {
    meetings: { current: meetingsCurrent || 0, previous: meetingsPrevious || 0 },
    pendingItems: pendingItems || 0,
    completedItems: { current: completedCurrent || 0, previous: completedPrevious || 0 },
    contactsAdded: { current: contactsCurrent || 0, previous: contactsPrevious || 0 },
    emailsSent: { current: emailsSentCurrent || 0, previous: emailsSentPrevious || 0 },
    touchpoints: { current: (interactionsCurrent || 0) + (meetingsCurrent || 0), previous: (interactionsPrevious || 0) + (meetingsPrevious || 0) },
  };
}

/**
 * Get daily activity counts for the last 4 months for the heatmap.
 * Start date is aligned to the nearest Sunday ~4 months ago, end date is today.
 */
export async function getActivityHeatmap(userId: string) {
  const now = new Date();
  // Go back ~6 months and align to Sunday
  const start = new Date(now);
  start.setMonth(start.getMonth() - 6);
  start.setDate(start.getDate() - start.getDay()); // Align to Sunday
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().split("T")[0];

  const [{ data: meetings }, { data: completedItems }, { data: interactions }, { data: sentEmails }] = await Promise.all([
    supabase.from("meetings").select("meeting_date").eq("user_id", userId).gte("meeting_date", startStr),
    supabase.from("follow_up_action_items").select("completed_at").eq("user_id", userId).eq("is_completed", true).gte("completed_at", start.toISOString()),
    supabase.from("interactions").select("interaction_date, contacts!inner()").eq("contacts.user_id", userId).gte("interaction_date", startStr),
    supabase.from("email_messages").select("date").eq("user_id", userId).eq("direction", "outbound").gte("date", startStr),
  ]);

  // Build day map with breakdown by type
  type DayBreakdown = { conversations: number; actions: number; contacts: number };
  const dayMap = new Map<string, DayBreakdown>();
  const getDay = (date: string) => {
    const existing = dayMap.get(date);
    if (existing) return existing;
    const fresh = { conversations: 0, actions: 0, contacts: 0 };
    dayMap.set(date, fresh);
    return fresh;
  };

  if (meetings) {
    for (const m of meetings) {
      const d = m.meeting_date?.split("T")[0];
      if (d) getDay(d).conversations++;
    }
  }
  if (completedItems) {
    for (const a of completedItems) {
      const d = a.completed_at?.split("T")[0];
      if (d) getDay(d).actions++;
    }
  }
  if (sentEmails) {
    for (const e of sentEmails) {
      const d = e.date?.split("T")[0];
      if (d) getDay(d).actions++;
    }
  }
  if (interactions) {
    for (const i of interactions) {
      const d = i.interaction_date;
      if (d) getDay(d).conversations++;
    }
  }

  // Also count contacts added per day
  const { data: newContacts } = await supabase
    .from("contacts")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", start.toISOString());

  if (newContacts) {
    for (const c of newContacts) {
      const d = c.created_at?.split("T")[0];
      if (d) getDay(d).contacts++;
    }
  }

  // Helper to format date as YYYY-MM-DD in local timezone (avoids UTC shift)
  const toLocalDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

  // Build array from start through today (local dates)
  const result: { date: string; count: number; dayOfWeek: number; conversations: number; actions: number; contacts: number }[] = [];
  const todayStr = toLocalDateStr(now);
  const d = new Date(start);
  while (toLocalDateStr(d) <= todayStr) {
    const dateStr = toLocalDateStr(d);
    const breakdown = dayMap.get(dateStr) || { conversations: 0, actions: 0, contacts: 0 };
    result.push({
      date: dateStr,
      count: breakdown.conversations + breakdown.actions + breakdown.contacts,
      dayOfWeek: d.getDay(),
      ...breakdown,
    });
    d.setDate(d.getDate() + 1);
  }

  return result;
}

/**
 * Get network health summary for the donut chart.
 * Returns counts by category: healthy, due, overdue, neverContacted, noCadence.
 */
export async function getNetworkHealthSummary(userId: string) {
  const contacts = await getContactsWithLastTouch(userId);

  const summary = { healthy: 0, dueSoon: 0, overdue: 0, neverContacted: 0, noCadence: 0, total: contacts.length };

  for (const c of contacts) {
    if (!c.follow_up_frequency_days) {
      if (c.days_since_touch === null) summary.neverContacted++;
      else summary.noCadence++;
      continue;
    }
    if (c.days_since_touch === null) {
      summary.neverContacted++;
      continue;
    }
    const ratio = c.days_since_touch / c.follow_up_frequency_days;
    if (ratio <= 0.85) summary.healthy++;
    else if (ratio <= 1.0) summary.dueSoon++;
    else summary.overdue++;
  }

  return summary;
}

/**
 * Get contacts that are 2x+ past their follow-up cadence (neglected relationships).
 */
export async function getNeglectedContacts(userId: string) {
  const contacts = await getContactsWithLastTouch(userId);

  return contacts
    .filter((c) => {
      if (!c.follow_up_frequency_days || c.follow_up_frequency_days <= 0) return false;
      if (c.days_since_touch === null) return true; // Never contacted with cadence set
      return c.days_since_touch >= c.follow_up_frequency_days * 2;
    })
    .sort((a, b) => {
      const aRatio = a.days_since_touch !== null && a.follow_up_frequency_days
        ? a.days_since_touch / a.follow_up_frequency_days : 999;
      const bRatio = b.days_since_touch !== null && b.follow_up_frequency_days
        ? b.days_since_touch / b.follow_up_frequency_days : 999;
      return bRatio - aRatio;
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      days_since_touch: c.days_since_touch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    }));
}
