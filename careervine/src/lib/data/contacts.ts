/**
 * Contact domain queries: contact CRUD, list projections, photo, and the
 * per-contact subresources (emails, phones, tags, companies, schools,
 * locations), plus network-tier activation (CAR-146 split of queries.ts).
 *
 * All functions are async, throw on failure unless annotated
 * error-tolerated, and rely on RLS for user scoping unless explicitly
 * filtered. The Supabase client is resolved lazily via db() so this module
 * is safe to import from server and MCP contexts.
 */

import { db, must, type QueryClient } from "./client";
import { chunked, chunkList, escapeIlike, paginateAll } from "./postgrest";
import { parseManualLocation } from "@/lib/location-normalizer";
import type { Database } from "@/lib/database.types";
import type { Contact, ContactListItem } from "@/lib/types";
import { findOrCreateCompany as findOrCreateCompanyShared } from "@/lib/company-helpers";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { validateContactPhotoFile } from "@/lib/contact-photo";
import { findOrCreateLocation } from "./locations";

export { findOrCreateLocation } from "./locations";

/**
 * Build a lookup map of email address → contact info.
 * Used to match calendar event attendees to known contacts.
 */
export async function getContactEmailLookup(userId: string) {
  const data = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contact_emails")
        .select("email, contact_id, contacts!inner(id, name, photo_url, user_id)")
        .eq("contacts.user_id", userId)
        .order("id")
        .range(from, to),
    ),
  );

  const map = new Map<string, { id: number; name: string; photo_url: string | null }>();
  for (const row of data) {
    if (row.email && row.contacts) {
      map.set(row.email.toLowerCase(), {
        id: row.contacts.id,
        name: row.contacts.name,
        photo_url: row.contacts.photo_url,
      });
    }
  }
  return map;
}

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
 * @returns Array of contacts with all related data (the `Contact` shape —
 *   inferred from CONTACTS_SELECT, not asserted; see the lockstep check below)
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

// Lean column set for the contacts LIST (CAR-94). The list only reads
// company/school/tag names (plus the narrow join rows), so the wide leaf tables
// are trimmed to id+name and the unused `locations` join is dropped — a large
// payload cut on big networks where every row drags full companies/schools rows.
// Row shape matches the `ContactListItem` type. getContacts keeps the full
// CONTACTS_SELECT for its other consumers.
const CONTACTS_LIST_SELECT = `
  *,
  contact_emails(*),
  contact_phones(*),
  contact_companies(
    *,
    companies(id, name)
  ),
  contact_schools(
    *,
    schools(id, name)
  ),
  contact_tags(
    *,
    tags(id, name)
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
  // and the old limit(500) silently truncated. id breaks name ties so the
  // range windows stay stable between requests.
  return await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select(CONTACTS_SELECT)
        .eq("user_id", userId)
        .in("network_status", statuses)
        .order("name")
        .order("id")
        .range(from, to),
    ),
  );
}

// Lockstep tripwire (CAR-158): getContacts' row shape is INFERRED from
// CONTACTS_SELECT, never asserted, so the signature cannot lie about what
// callers actually receive. Callers annotate with the shared `Contact` type,
// so this compile-time check fails the build the moment the select and the
// type drift apart in either direction, instead of a stale `as Contact[]`
// papering over it (the CAR-142 any-debt this ticket retires).
type Assert<T extends true> = T;
type _ContactsSelectMatchesContact = Assert<
  Awaited<ReturnType<typeof getContacts>>[number] extends Contact
    ? Contact extends Awaited<ReturnType<typeof getContacts>>[number]
      ? true
      : false
    : false
>;

/**
 * Streaming variant of {@link getContacts}: fetches contacts in ascending
 * name order and invokes `onPage` with each page as it arrives, so the caller
 * can paint the first rows without waiting for the full result set.
 *
 * The first page is deliberately small (`FIRST_PAGE`) for a fast first paint;
 * subsequent pages are large to minimise round-trips on big networks. Pages
 * are contiguous ranges over `order("name")` with `id` as the tiebreak (a
 * stable total order), so appending them in call order yields the same
 * name-sorted list `getContacts` returns.
 *
 * Uses the lean CONTACTS_LIST_SELECT (row shape = `ContactListItem`), not the
 * full CONTACTS_SELECT — the list view doesn't need the wide leaf-table columns.
 *
 * (Keeps its own loop rather than paginateAll: the variable first-page size
 * doesn't fit fixed-window pagination.)
 *
 * @returns the full accumulated array (ContactListItem shape).
 */
export async function getContactsStreamed(
  userId: string,
  statuses: Array<"active" | "prospect" | "bench">,
  onPage: (rows: ContactListItem[]) => void,
) {
  const FIRST_PAGE = 50;
  const REST_PAGE = 1000;
  // Annotation, not assertion (CAR-158): the query's inferred rows are
  // *checked* against ContactListItem on the push/onPage below, so a select
  // that stops matching the type is a compile error here rather than a lie
  // the callers have to cast their way back out of.
  const all: ContactListItem[] = [];
  let from = 0;
  let size = FIRST_PAGE;
  for (;;) {
    const { data, error } = await db()
      .from("contacts")
      .select(CONTACTS_LIST_SELECT)
      .eq("user_id", userId)
      .in("network_status", statuses)
      .order("name")
      .order("id")
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
  const { data, error } = await db()
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
 * CAR-155 chokepoint invariant: the contacts table dedupes on exact
 * linkedin_url string equality (see src/lib/linkedin-url.ts), so the URL is
 * canonicalized HERE, inside the write module — no caller can skip it.
 * Parseable LinkedIn profile URLs land in canonical form; anything else is
 * stored as typed minus trim + trailing slashes (no silent data loss), with
 * empty collapsing to null — exactly the transform the DB tidy trigger
 * (20260719120000) applies, so the value the app computes is always the
 * value the row stores. An explicit null still clears the column.
 */
function canonicalizeContactPayload<T extends { linkedin_url?: string | null }>(payload: T): T {
  if (payload.linkedin_url == null) return payload;
  const canonical = canonicalizeLinkedinUrl(payload.linkedin_url);
  return { ...payload, linkedin_url: canonical ?? (payload.linkedin_url.trim().replace(/\/+$/, "") || null) };
}

/** Options accepted by the contact write chokepoint (CAR-155). */
interface ContactWriteOptions {
  /**
   * Explicit client for server contexts (extension-auth route, service
   * role). Callers passing a service client are responsible for ownership
   * scoping — pass userId on updates.
   */
  client?: QueryClient;
}

/**
 * Create a new contact — THE insert chokepoint for the contacts table
 * (CAR-155): every surface (web forms, extension import, MCP, admin) funnels
 * through here so linkedin_url canonicalization cannot be skipped.
 *
 * @param contact - Contact data matching the contacts table schema (without id)
 * @returns Promise<Contact> - The created contact with generated id
 * @throws Error if creation fails
 */
export async function createContact(
  contact: Database["public"]["Tables"]["contacts"]["Insert"],
  opts: ContactWriteOptions = {},
) {
  const { data, error } = await (opts.client ?? db())
    .from("contacts")
    .insert(canonicalizeContactPayload(contact))
    .select()
    .single();  // Return the single created record

  if (error) throw error;
  return data;
}

/**
 * Bulk-create contacts through the same chokepoint (canonicalization per
 * row). Returns the created rows in VALUES order (Postgres RETURNING
 * preserves it). Used by the bulk import pipeline.
 */
export async function createContacts(
  contacts: Database["public"]["Tables"]["contacts"]["Insert"][],
  opts: ContactWriteOptions = {},
) {
  const { data, error } = await (opts.client ?? db())
    .from("contacts")
    .insert(contacts.map(canonicalizeContactPayload))
    .select();

  if (error) throw error;
  return data ?? [];
}

/**
 * Update an existing contact — THE update chokepoint for the contacts table
 * (CAR-155), same canonicalization guarantee as createContact.
 *
 * @param id - The contact's ID
 * @param updates - Partial contact data to update
 * @returns Promise<Contact> - The updated contact (null with minimal: true)
 * @throws Error if update fails (with the default returning read, also when
 *   no row matched)
 */
export async function updateContact(
  id: number,
  updates: Database["public"]["Tables"]["contacts"]["Update"],
  opts: ContactWriteOptions & {
    /** Ownership scoping for non-RLS clients: adds .eq("user_id", userId). */
    userId?: string;
    /**
     * Skip the returning .select().single() read. For bulk/pipeline callers
     * that must not fail when the row vanished mid-run; a no-match update is
     * then silently zero rows, matching their historical semantics.
     */
    minimal?: boolean;
  } = {},
) {
  let query = (opts.client ?? db())
    .from("contacts")
    .update(canonicalizeContactPayload(updates))
    .eq("id", id);
  if (opts.userId) query = query.eq("user_id", opts.userId);

  if (opts.minimal) {
    const { error } = await query;
    if (error) throw error;
    return null;
  }

  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}

/**
 * Append a note to a contact's existing notes, separated by newlines.
 */
export async function appendContactNote(contactId: number, note: string) {
  const { error } = await db().rpc("append_contact_note", {
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
  const rows = await chunked(contactIds, async (chunk) =>
    must(
      await db()
        .from("contact_change_events")
        .select("contact_id")
        .eq("type", "company_change")
        .eq("status", "new")
        .in("contact_id", chunk),
    ),
  );
  return new Set(rows.map((r) => r.contact_id));
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
  const { data: contact, error } = await db()
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
  // The whole block is best-effort: the contact row is already gone, so
  // tombstone bookkeeping must never fail the delete itself.
  if (contact?.import_source && contact.linkedin_url && contact.user_id) {
    const canonical = canonicalizeLinkedinUrl(contact.linkedin_url);
    if (canonical) {
      try {
        // A surviving duplicate contact with the same URL still wants import
        // refreshes — suppressing it would silently freeze that contact.
        // must(): an errored probe must not be mistaken for "no survivor";
        // the catch below skips the tombstone instead of writing a wrong one.
        const survivor = must(
          await db()
            .from("contacts")
            .select("id")
            .eq("user_id", contact.user_id)
            .eq("linkedin_url", canonical)
            .limit(1)
            .maybeSingle(),
        );
        if (!survivor) {
          const { error: tombstoneError } = await db()
            .from("suppressed_imports")
            .upsert(
              { user_id: contact.user_id, linkedin_url: canonical },
              { onConflict: "user_id,linkedin_url", ignoreDuplicates: true },
            );
          if (tombstoneError) {
            console.warn(`[deleteContact] Tombstone write failed for contact ${id}:`, tombstoneError);
          }
        }
      } catch (probeError) {
        console.warn(`[deleteContact] Survivor probe failed for contact ${id}; skipping tombstone:`, probeError);
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
 * Provenance for an email address the user is about to send to —
 * powers the compose modal's pattern-guessed / bounced warnings.
 */
export async function getEmailProvenance(address: string) {
  const clean = address.trim().toLowerCase();
  if (!clean) return null;
  // error-tolerated: provenance only powers a compose warning badge; a
  // failed read renders as "no warning" rather than blocking composing.
  const { data } = await db()
    .from("contact_emails")
    .select("id, source, bounced_at")
    .eq("email", clean)
    .limit(1);
  return (data?.[0] as { id: number; source: string; bounced_at: string | null } | undefined) ?? null;
}

/** Flip a pattern-guessed address to verified (e.g. after a reply). */
export async function markEmailVerified(emailId: number) {
  const { error } = await db()
    .from("contact_emails")
    .update({ source: "verified" })
    .eq("id", emailId);
  if (error) throw error;
}

/**
 * First real touch (interaction, meeting, outbound email) graduates
 * imported prospects/bench contacts into the active network (plan 24
 * tier transition). No-op for contacts already active.
 *
 * Internal to src/lib/data (not re-exported from the queries barrel):
 * app code activates through the flows that call this.
 */
export async function activateContacts(contactIds: number[]) {
  if (contactIds.length === 0) return;
  for (const chunk of chunkList(contactIds, 200)) {
    // error-tolerated: deliberate fire-and-forget — activation piggybacks on
    // the user's real action (logging a touch), which must never fail on it.
    const { error } = await db()
      .from("contacts")
      .update({ network_status: "active" })
      .in("id", chunk)
      .in("network_status", ["prospect", "bench"]);
    if (error) console.error("Failed to activate contacts:", error);
  }
}

/**
 * Fast per-tier contact counts for the network tier toggle chips, so the
 * numbers arrive long before the full contact payload finishes loading.
 *
 * One `network_tier_counts` RPC (a POST) rather than three `HEAD count=exact`
 * requests: the HEADs consistently 503 at the Supabase/Cloudflare edge on a
 * cold page load (CAR-98), and one round trip beats three. The function is
 * scoped to auth.uid() server-side, so no userId argument is needed.
 */
export async function getNetworkTierCounts() {
  const { data, error } = await db().rpc("network_tier_counts").single();
  // network_tier_counts isn't in the generated types, so the row comes back as
  // {}; the function returns one row of bigint counts (serialized as numbers).
  const row = data as { active: number; prospect: number; bench: number } | null;
  // error-tolerated: the tier chips render 0s and correct themselves when
  // the full contact payload lands moments later.
  if (error || !row) return { active: 0, prospect: 0, bench: 0 };
  return {
    active: Number(row.active) || 0,
    prospect: Number(row.prospect) || 0,
    bench: Number(row.bench) || 0,
  };
}

/**
 * Manually promote a single prospect/bench contact into the active
 * network (the "Add to network" button). Unlike the fire-and-forget
 * bulk activateContacts(), this throws so the UI can surface failures.
 */
export async function activateContact(contactId: number) {
  const { error } = await db()
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
  const { data, error } = await db()
    .from("tags")
    .select("*")
    .eq("user_id", userId)
    .order("name");

  if (error) throw error;
  return data;
}

/**
 * Tag names on one contact (CAR-158).
 *
 * Focused counterpart to getContactById, which pulls every join and is far
 * more than a caller needs to answer "is this contact tagged X?". Added when
 * the availability picker's priority detection was found calling
 * `/api/contacts/[id]/tags`, a route that never existed in this repo's
 * history: the `if (res.ok)` guard swallowed the 404, so the feature silently
 * never worked. Reading through the data layer keeps it on RLS and avoids
 * standing up a new API surface for one boolean.
 *
 * @returns tag names for the contact, or [] when it has none.
 */
export async function getContactTagNames(
  contactId: number,
  userId: string,
): Promise<string[]> {
  const { data, error } = await db()
    .from("contact_tags")
    .select("tags(name), contacts!inner(user_id)")
    .eq("contact_id", contactId)
    .eq("contacts.user_id", userId);

  if (error) throw error;
  return (data ?? []).flatMap((row) => (row.tags?.name ? [row.tags.name] : []));
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
  const { data, error } = await db()
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
  return await findOrCreateCompanyShared(db(), { name });
}

/**
 * Link a company to a contact with job details (title, is_current)
 *
 * @param contactCompany - Junction table row data
 * @returns Promise<ContactCompany> - The created link
 * @throws Error if insertion fails
 */
export async function addCompanyToContact(contactCompany: Database["public"]["Tables"]["contact_companies"]["Insert"]) {
  const { data, error } = await db()
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
  const { error } = await db()
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
  const clean = name.trim();
  // Case-insensitive probe (CAR-151), matching company-helpers' find-or-create
  // semantics so "byu" reuses an existing "BYU" instead of duplicating it.
  //
  // The ilike is only an index-friendly narrowing; the match is decided in JS.
  // PostgREST treats `*` as an alias for `%` and offers no way to express a
  // literal `*` in a like pattern (escapeIlike deliberately leaves it alone,
  // since `\*` is rewritten to `\%` and would match nothing), so the probe for
  // "A*M" also returns rows like "ATM". Any stored literal `*` still matches
  // its own wildcarded pattern, so the true row is guaranteed to be among the
  // candidates. must(): an errored probe must not fall through to the insert
  // and create a duplicate row. order("id") keeps the choice deterministic
  // when historical case-variant duplicates exist.
  const probe = async () => {
    const candidates = await paginateAll(async (from, to) =>
      must(await db().from("schools").select("*").ilike("name", escapeIlike(clean)).order("id").range(from, to)),
    );
    return candidates.find((c) => c.name.trim().toLowerCase() === clean.toLowerCase()) ?? null;
  };
  const existing = await probe();
  if (existing) return existing;

  // Create new. Concurrent saves of the same new name race here: schools.name
  // is UNIQUE, so the loser refetches the winner's row instead of failing the
  // whole contact save (same recovery as company-helpers' find-or-creates).
  const { data, error } = await db()
    .from("schools")
    .insert({ name: clean })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      const winner = await probe();
      if (winner) return winner;
    }
    throw error;
  }
  return data;
}

// findOrCreateLocation lives in ./locations (CAR-155) and is re-exported at
// the top of this module: normalization now runs inside the shared
// implementation, so every writer collapses onto canonical rows.

/**
 * Resolve a manually-entered work-experience location string into the
 * contact_companies location columns. Normalizes the free text with the same
 * parser the scrape/import pipeline uses and find-or-creates the canonical
 * `locations` row (location_id), keeping the original text in location_raw so
 * it can be re-normalized later. Country-only / vague / unparseable input keeps
 * the raw text with no location_id.
 */
export async function resolveManualCompanyLocation(raw: string | null | undefined): Promise<{
  location: string | null;
  location_id: number | null;
  location_source: string | null;
  location_raw: string | null;
}> {
  const parsed = parseManualLocation(raw);
  if (!parsed.display) {
    return { location: null, location_id: null, location_source: null, location_raw: null };
  }
  if (!parsed.isPlace) {
    return { location: parsed.display, location_id: null, location_source: "manual", location_raw: parsed.display };
  }
  const location = await findOrCreateLocation({ city: parsed.city, state: parsed.state, country: parsed.country });
  return { location: parsed.display, location_id: location?.id ?? null, location_source: "manual", location_raw: (raw ?? "").trim() };
}

/**
 * Link a school to a contact with education details (degree, field_of_study, etc.)
 *
 * @param contactSchool - Junction table row data
 * @returns Promise<ContactSchool> - The created link
 * @throws Error if insertion fails
 */
export async function addSchoolToContact(contactSchool: Database["public"]["Tables"]["contact_schools"]["Insert"]) {
  const { data, error } = await db()
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
  const { error } = await db()
    .from("contact_schools")
    .delete()
    .eq("contact_id", contactId);
  if (error) throw error;
}

// ── Contact Emails ──

export async function addEmailToContact(contactId: number, email: string, isPrimary: boolean) {
  const { data, error } = await db()
    .from("contact_emails")
    .insert({ contact_id: contactId, email, is_primary: isPrimary })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeEmailsFromContact(contactId: number) {
  const { error } = await db().from("contact_emails").delete().eq("contact_id", contactId);
  if (error) throw error;
}

// ── Contact Phones ──

export async function addPhoneToContact(contactId: number, phone: string, type: string, isPrimary: boolean) {
  const { data, error } = await db()
    .from("contact_phones")
    .insert({ contact_id: contactId, phone, type, is_primary: isPrimary })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removePhonesFromContact(contactId: number) {
  const { error } = await db().from("contact_phones").delete().eq("contact_id", contactId);
  if (error) throw error;
}

// ── Tags ──

export async function addTagToContact(contactId: number, tagId: number) {
  const { error } = await db().from("contact_tags").insert({ contact_id: contactId, tag_id: tagId });
  if (error) throw error;
}

export async function removeTagFromContact(contactId: number, tagId: number) {
  const { error } = await db()
    .from("contact_tags")
    .delete()
    .eq("contact_id", contactId)
    .eq("tag_id", tagId);
  if (error) throw error;
}
