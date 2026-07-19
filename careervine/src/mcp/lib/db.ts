/**
 * Service-role data layer for the MCP server.
 *
 * Since CAR-151 this is a thin layer, not a fork: the shared src/lib/data
 * modules receive the service client through their setDataClient() seam
 * (and company-queries through setCompanyQueriesClient()), and every
 * shared function MCP reaches is explicitly user-scoped — enforced
 * exhaustively by __tests__/db-scoping.test.ts. What remains here is
 * MCP-specific: uid() context, contact/company resolution and ownership
 * assertions, and tool-shaped projections/aggregations. The service role
 * bypasses RLS, so every query in this module scopes to the operating
 * user or runs behind an ownership assertion.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import type { TablesInsert } from "@/lib/database.types";
import { setCompanyQueriesClient } from "@/lib/company-queries";
import { setDataClient, type QueryClient } from "@/lib/data/client";
import { chunked, escapeIlike, paginateAll } from "@/lib/data/postgrest";
import {
  addCompanyToContact,
  addEmailToContact,
  addPhoneToContact,
  addSchoolToContact,
  appendContactNote,
  createContact,
  findOrCreateCompany,
  findOrCreateLocation,
  findOrCreateSchool,
  getContactById,
  getContactEmailLookup,
} from "@/lib/data/contacts";
import {
  buildLastTouchMap as buildLastTouchMapShared,
  getContactsDueForFollowUp,
  getNeglectedContacts,
  getRelationshipsOnTrack,
} from "@/lib/data/follow-ups";
import { getNetworkingStreak } from "@/lib/data/home";
import { createActionItem as createActionItemShared, getActionItems } from "@/lib/data/action-items";
import {
  cancelFollowUpSequenceCascade,
  cancelScheduledEmailCascade,
  insertEmailDraft,
  insertFollowUpSequenceRows,
  insertScheduledEmail,
} from "@/lib/data/emails";
import { canonicalUsState, isUnitedStates } from "@/lib/us-states";
import { sanitizeForPostgrest } from "@/lib/import-helpers";
import { currentUserIdOrNull } from "@/mcp/user-context";
import { trackServer, checkContactMilestone } from "@/lib/analytics/server";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

let client: ServiceClient | null = null;
/** Stdio-only fallback when no per-request ALS context is set. */
let stdioUserId = "";

function ensureClient(): ServiceClient {
  if (!client) {
    client = createSupabaseServiceClient();
    // Park the service client in the shared data-layer seams. Module-global
    // by design (deterministic, no per-request swapping): safe because every
    // shared function MCP reaches scopes by userId explicitly (gate suite),
    // and no server-side web code resolves these seams implicitly.
    setDataClient(client as QueryClient);
    setCompanyQueriesClient(client as Parameters<typeof setCompanyQueriesClient>[0]);
  }
  return client;
}

/**
 * Initialize the service client and optionally pin the stdio operating user.
 * HTTP callers invoke initDb() once (client only) and scope each request via ALS.
 */
export function initDb(uid?: string): void {
  if (uid) stdioUserId = uid;
  ensureClient();
}

export function db(): ServiceClient {
  return ensureClient();
}

export function uid(): string {
  // Ensure the client seams are wired before any shared data function runs:
  // every entry point here resolves uid() first, so this guarantees the
  // shared modules never fall back to the browser client in an MCP process.
  ensureClient();
  const requestUser = currentUserIdOrNull();
  if (requestUser) return requestUser;
  if (stdioUserId) return stdioUserId;
  throw new Error("db not initialized — call initDb() or run inside runWithUser()");
}

// ── Contact resolution ─────────────────────────────────────────────────

export interface ContactRef {
  contact_id?: number;
  name?: string;
}

export interface ContactCore {
  id: number;
  name: string;
  network_status: string;
  stage_override: string | null;
}

const CONTACT_CORE_COLS = "id, name, network_status, stage_override";

/**
 * Resolve a contact by id or name. Name matching tries exact
 * (case-insensitive) first, then substring; ambiguity throws an error
 * listing the candidates with ids so the caller can retry by id.
 */
export async function resolveContact(ref: ContactRef): Promise<ContactCore> {
  if (ref.contact_id != null) {
    const { data, error } = await db()
      .from("contacts")
      .select(CONTACT_CORE_COLS)
      .eq("user_id", uid())
      .eq("id", ref.contact_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`No contact with id ${ref.contact_id}`);
    return data as ContactCore;
  }

  const name = ref.name?.trim();
  if (!name) throw new Error("Provide contact_id or name");

  const { data: exact, error: exactErr } = await db()
    .from("contacts")
    .select(CONTACT_CORE_COLS)
    .eq("user_id", uid())
    .ilike("name", escapeIlike(name))
    .limit(10);
  if (exactErr) throw exactErr;
  if (exact?.length === 1) return exact[0] as ContactCore;
  if ((exact?.length ?? 0) > 1) throw ambiguity(name, exact as ContactCore[]);

  const { data: fuzzy, error: fuzzyErr } = await db()
    .from("contacts")
    .select(CONTACT_CORE_COLS)
    .eq("user_id", uid())
    .ilike("name", `%${escapeIlike(name)}%`)
    .limit(10);
  if (fuzzyErr) throw fuzzyErr;
  if (fuzzy?.length === 1) return fuzzy[0] as ContactCore;
  if ((fuzzy?.length ?? 0) > 1) throw ambiguity(name, fuzzy as ContactCore[]);
  throw new Error(`No contact matches "${name}"`);
}

function ambiguity(name: string, candidates: ContactCore[]): Error {
  const list = candidates
    .map((c) => `  - ${c.name} (id ${c.id}, ${c.network_status})`)
    .join("\n");
  return new Error(
    `"${name}" matches ${candidates.length} contacts — retry with contact_id:\n${list}`,
  );
}

/** Throw unless the contact belongs to the operating user. */
export async function assertContactOwned(contactId: number): Promise<ContactCore> {
  return resolveContact({ contact_id: contactId });
}

// ── Contact reads ──────────────────────────────────────────────────────

/** Full contact with relations — the app's getContactById, bound to uid(). */
export async function getContactFull(contactId: number) {
  return getContactById(contactId, uid());
}

export interface SearchRow {
  id: number;
  name: string;
  headline: string | null;
  industry: string | null;
  network_status: string;
  stage_override: string | null;
  contact_emails: Array<{ email: string | null; is_primary: boolean; source: string; bounced_at: string | null }>;
  contact_companies: Array<{ title: string | null; is_current: boolean; companies: { name: string } | null }>;
  contact_schools: Array<{ schools: { name: string } | null }>;
  contact_tags: Array<{ tags: { name: string } | null }>;
}

/**
 * Fetch all of the user's contacts in a compact search shape (paged —
 * bulk imports push counts past PostgREST's 1000-row cap; id breaks name
 * ties so the range windows stay stable).
 */
export async function fetchSearchRows(tiers?: string[]): Promise<SearchRow[]> {
  const statuses = tiers?.length ? tiers : ["active", "prospect", "bench"];
  return paginateAll<SearchRow>(async (from, to) => {
    const { data, error } = await db()
      .from("contacts")
      .select(`
        id, name, headline, industry, network_status, stage_override,
        contact_emails(email, is_primary, source, bounced_at),
        contact_companies(title, is_current, companies(name)),
        contact_schools(schools(name)),
        contact_tags(tags(name))
      `)
      .eq("user_id", uid())
      .in("network_status", statuses)
      .order("name")
      .order("id")
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as SearchRow[];
  });
}

/** Latest touch (meeting or logged interaction) per contact — shared map, bound to uid(). */
export async function buildLastTouchMap(contactIds: number[]): Promise<Map<number, string>> {
  return buildLastTouchMapShared(uid(), contactIds);
}

// ── Contact writes ─────────────────────────────────────────────────────

export interface NewContactInput {
  name: string;
  industry?: string;
  linkedin_url?: string;
  notes?: string;
  met_through?: string;
  follow_up_frequency_days?: number;
  network_status?: "active" | "prospect" | "bench";
  emails?: string[];
  phones?: Array<{ phone: string; type?: string }>;
  company?: { name: string; title?: string; is_current?: boolean };
  school?: { name: string; degree?: string; field_of_study?: string };
  location?: { city?: string; state?: string; country: string };
}

export async function createContactFull(input: NewContactInput): Promise<number> {
  const userId = uid();
  let locationId: number | null = null;
  if (input.location) {
    const rawState = input.location.state ?? null;
    // Canonicalize US state to the full name ("CA" -> "California") so an
    // agent-added location matches the web dropdown + scrape/import pipeline;
    // findOrCreateLocation matches on exact state equality, so "CA" and
    // "California" would otherwise become two rows. Non-US passes through.
    const state = isUnitedStates(input.location.country)
      ? (canonicalUsState(rawState) ?? rawState)
      : rawState;
    const loc = await findOrCreateLocation({
      city: input.location.city ?? null,
      state,
      country: input.location.country,
    });
    locationId = loc.id;
  }

  const contact = await createContact({
    user_id: userId,
    name: input.name,
    industry: input.industry ?? null,
    linkedin_url: input.linkedin_url ?? null,
    notes: input.notes ?? null,
    met_through: input.met_through ?? null,
    follow_up_frequency_days: input.follow_up_frequency_days ?? null,
    network_status: input.network_status ?? "active",
    location_id: locationId,
    preferred_contact_method: null,
    preferred_contact_value: null,
    contact_status: null,
    expected_graduation: null,
  });
  const contactId = (contact as { id: number }).id;

  // The contact row is already committed; the child writes below are not
  // transactional (Supabase JS has no client-side transaction) and are safe
  // under the service client because they key on the contact we just created
  // for uid(). If any child fails, roll back by deleting the contact so a
  // retry doesn't orphan a partial/duplicate contact. Cascade FKs clean up
  // any children written so far.
  try {
    for (const [i, email] of (input.emails ?? []).entries()) {
      await addEmailToContact(contactId, email.trim().toLowerCase(), i === 0);
    }
    for (const [i, p] of (input.phones ?? []).entries()) {
      await addPhoneToContact(contactId, p.phone, p.type ?? "mobile", i === 0);
    }
    if (input.company?.name) {
      const company = await findOrCreateCompany(input.company.name);
      await addCompanyToContact({
        contact_id: contactId,
        company_id: company.id,
        title: input.company.title ?? null,
        is_current: input.company.is_current ?? true,
        location: null,
        start_date: null,
        end_date: null,
        start_month: null,
        end_month: null,
      });
    }
    if (input.school?.name) {
      const school = await findOrCreateSchool(input.school.name);
      await addSchoolToContact({
        contact_id: contactId,
        school_id: (school as { id: number }).id,
        degree: input.school.degree ?? null,
        field_of_study: input.school.field_of_study ?? null,
        start_year: null,
        end_year: null,
      });
    }
  } catch (childErr) {
    await db().from("contacts").delete().eq("id", contactId).eq("user_id", userId);
    throw childErr;
  }

  // Assistant-created contacts count toward the contacts funnel and the
  // contacts_5 milestone like every other surface (CAR-58 audit: this path
  // was invisible, so AI-driven users looked like they never activated).
  await trackServer(userId, "contact_imported", { source: "mcp" }, "mcp");
  await checkContactMilestone(userId);

  return contactId;
}

export async function appendNote(contactId: number, note: string): Promise<void> {
  // Ownership assertion is the scoping here: the shared RPC keys on the
  // contact id alone, and the service role bypasses RLS inside it.
  await assertContactOwned(contactId);
  await appendContactNote(contactId, note);
}

export async function tagContact(contactId: number, tagNames: string[]): Promise<string[]> {
  await assertContactOwned(contactId);
  const applied: string[] = [];
  for (const rawName of tagNames) {
    const name = rawName.trim();
    if (!name) continue;
    const { data: existing } = await db()
      .from("tags")
      .select("id, name")
      .eq("user_id", uid())
      .ilike("name", escapeIlike(name))
      .limit(1);
    let tagId = (existing?.[0] as { id: number } | undefined)?.id;
    if (!tagId) {
      const { data: created, error } = await db()
        .from("tags")
        .insert({ user_id: uid(), name })
        .select("id")
        .single();
      if (error) throw error;
      tagId = (created as { id: number }).id;
    }
    const { error: linkErr } = await db()
      .from("contact_tags")
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
    if (linkErr) throw linkErr;
    applied.push(name);
  }
  return applied;
}

export async function setNetworkStatus(
  contactId: number,
  status: "active" | "prospect" | "bench",
): Promise<{ previous: string }> {
  const contact = await assertContactOwned(contactId);
  const { error } = await db()
    .from("contacts")
    .update({ network_status: status })
    .eq("id", contactId)
    .eq("user_id", uid());
  if (error) throw error;
  return { previous: contact.network_status };
}

/**
 * Graduate a prospect/bench contact into the active network. Used by the
 * relationship-forming writes (logged interaction, meeting link) per the
 * reply-based tier policy. Returns true if a graduation happened.
 */
export async function activateContactIfDormant(contactId: number): Promise<boolean> {
  const { data, error } = await db()
    .from("contacts")
    .update({ network_status: "active" })
    .eq("id", contactId)
    .eq("user_id", uid())
    .in("network_status", ["prospect", "bench"])
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function setStageOverride(contactId: number, stage: string | null): Promise<void> {
  await assertContactOwned(contactId);
  const { error } = await db()
    .from("contacts")
    .update({ stage_override: stage })
    .eq("id", contactId)
    .eq("user_id", uid());
  if (error) throw error;
}

// ── Interactions ───────────────────────────────────────────────────────

export async function logInteraction(
  contactId: number,
  type: string,
  date: string,
  summary: string | null,
): Promise<{ interactionId: number; activated: boolean }> {
  await assertContactOwned(contactId);
  const { data, error } = await db()
    .from("interactions")
    .insert({
      contact_id: contactId,
      interaction_date: date,
      interaction_type: type,
      summary,
    })
    .select("id")
    .single();
  if (error) throw error;
  // A manually logged interaction is a real touch — it graduates
  // prospects/bench into the active network (plan 24 tier policy).
  const activated = await activateContactIfDormant(contactId);
  return { interactionId: (data as { id: number }).id, activated };
}

// ── Action items ───────────────────────────────────────────────────────

export async function createActionItem(input: {
  title: string;
  description?: string;
  due_at?: string;
  direction?: "my_task" | "waiting_on";
  contactIds: number[];
}): Promise<number> {
  for (const id of input.contactIds) await assertContactOwned(id);
  // Shared insert (payload carries user_id; the junction rows key on the
  // ownership-asserted contact ids above).
  const item = await createActionItemShared(
    {
      user_id: uid(),
      contact_id: input.contactIds[0] ?? null,
      meeting_id: null,
      title: input.title,
      description: input.description ?? null,
      due_at: input.due_at ?? null,
      is_completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      direction: input.direction ?? "my_task",
      source: "manual",
    },
    input.contactIds,
  );
  return (item as { id: number }).id;
}

export interface ActionItemRow {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  created_at: string | null;
  direction: string | null;
  snoozed_until: string | null;
  action_item_contacts: Array<{ contact_id: number; contacts: { id: number; name: string } | null }>;
}

export async function listActionItems(opts: {
  due?: "overdue" | "today" | "week" | "all";
  direction?: "my_task" | "waiting_on";
  contactId?: number;
}): Promise<ActionItemRow[]> {
  const now = new Date();
  // Shared fetch (the same pending-items query the web action list runs);
  // the due/direction/contact narrowing below is the MCP tool's aggregation.
  const rows = await getActionItems(uid());
  let items: ActionItemRow[] = (rows ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    due_at: r.due_at,
    is_completed: r.is_completed,
    completed_at: r.completed_at,
    created_at: r.created_at,
    direction: r.direction,
    snoozed_until: r.snoozed_until,
    action_item_contacts: r.action_item_contacts ?? [],
  }));

  if (opts.direction) {
    items = items.filter((i) => i.direction === opts.direction);
  }
  if (opts.contactId != null) {
    items = items.filter((i) => i.action_item_contacts.some((c) => c.contact_id === opts.contactId));
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);
  switch (opts.due) {
    case "overdue":
      items = items.filter((i) => i.due_at && new Date(i.due_at) < startOfToday);
      break;
    case "today":
      items = items.filter((i) => i.due_at && new Date(i.due_at) < endOfToday);
      break;
    case "week":
      items = items.filter((i) => i.due_at && new Date(i.due_at) < endOfWeek);
      break;
    default:
      break;
  }
  return items;
}

export async function updateActionItem(
  itemId: number,
  patch: {
    complete?: boolean;
    snooze_until?: string;
    due_at?: string | null;
    title?: string;
    description?: string | null;
  },
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (patch.complete) {
    updates.is_completed = true;
    updates.completed_at = new Date().toISOString();
  }
  if (patch.snooze_until !== undefined) updates.snoozed_until = patch.snooze_until;
  if (patch.due_at !== undefined) updates.due_at = patch.due_at;
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (Object.keys(updates).length === 0) throw new Error("No updates provided");

  const { data, error } = await db()
    .from("follow_up_action_items")
    .update(updates)
    .eq("id", itemId)
    .eq("user_id", uid())
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(`No action item with id ${itemId}`);
}

// ── Due follow-ups (home-page reach-out list) ──────────────────────────

export interface DueFollowUp {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
  never_contacted: boolean;
  no_cadence: boolean;
  has_email: boolean;
}

/** The app's reach-out list (shared derivation), projected to the MCP tool shape. */
export async function listDueFollowUps(): Promise<DueFollowUp[]> {
  const entries = await getContactsDueForFollowUp(uid());
  return entries.map((e) => ({
    id: e.id,
    name: e.name,
    industry: e.industry,
    follow_up_frequency_days: e.follow_up_frequency_days,
    last_touch: e.last_touch,
    days_overdue: e.days_overdue,
    never_contacted: e.never_contacted,
    no_cadence: e.no_cadence,
    has_email: e.emails.length > 0,
  }));
}

// ── Network health ─────────────────────────────────────────────────────

export async function getNetworkHealth() {
  const userId = uid();

  // Tier counts + last-30-day totals are MCP-specific aggregations; the
  // on-track ratio, neglected list, and streak are the web's own functions.
  const tiers = ["active", "prospect", "bench"] as const;
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [tierResults, onTrackRes, neglectedRes, streakRes, m30, i30, e30, a30] = await Promise.all([
    Promise.all(
      tiers.map((tier) =>
        db()
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("network_status", tier),
      ),
    ),
    getRelationshipsOnTrack(userId),
    getNeglectedContacts(userId),
    getNetworkingStreak(userId),
    db().from("meetings").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("meeting_date", thirtyAgo.split("T")[0]),
    db().from("interactions").select("id, contacts!inner(user_id)", { count: "exact", head: true }).eq("contacts.user_id", userId).gte("interaction_date", thirtyAgo.split("T")[0]),
    db().from("email_messages").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "outbound").eq("is_simulated", false).gte("date", thirtyAgo),
    db().from("follow_up_action_items").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", true).gte("completed_at", thirtyAgo),
  ]);
  const tierCounts = {
    active: tierResults[0].count ?? 0,
    prospect: tierResults[1].count ?? 0,
    bench: tierResults[2].count ?? 0,
  };

  return {
    tierCounts,
    onTrack: {
      percentage: onTrackRes.percentage,
      onTrack: onTrackRes.onTrack,
      total: onTrackRes.total,
    },
    streakDays: streakRes.streak,
    neglectedContacts: neglectedRes
      .map((n) => ({
        id: n.id,
        name: n.name,
        days_since_touch: n.days_since_touch,
        cadence_days: n.follow_up_frequency_days,
      }))
      .slice(0, 15),
    last30Days: {
      meetings: m30.count ?? 0,
      interactions: i30.count ?? 0,
      emailsSent: e30.count ?? 0,
      actionItemsCompleted: a30.count ?? 0,
    },
  };
}

// ── Email cache / scheduling ───────────────────────────────────────────

export async function searchEmailHistory(query: string, contactId?: number, limit = 20) {
  // Strip PostgREST filter-grammar metacharacters (commas, parens, quotes,
  // LIKE wildcards) before interpolating into .or(). An unescaped ")" in the
  // query otherwise closes the .or() group early and breaks the request —
  // sanitizeForPostgrest is the repo's established defense for exactly this.
  const pattern = `%${sanitizeForPostgrest(query)}%`;
  let q = db()
    .from("email_messages")
    .select("gmail_message_id, thread_id, subject, snippet, from_address, to_addresses, date, direction, matched_contact_id")
    .eq("user_id", uid())
    .eq("is_simulated", false)
    .or(`subject.ilike.${pattern},snippet.ilike.${pattern}`)
    .order("date", { ascending: false })
    .limit(limit);
  if (contactId != null) q = q.eq("matched_contact_id", contactId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getCachedThreadMessages(threadId: string) {
  const { data, error } = await db()
    .from("email_messages")
    .select("gmail_message_id, subject, snippet, from_address, to_addresses, date, direction")
    .eq("user_id", uid())
    .eq("thread_id", threadId)
    .order("date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createScheduledEmail(input: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyHtml: string;
  scheduledSendAt: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  contactName?: string;
  matchedContactId?: number | null;
}): Promise<number> {
  const row = await insertScheduledEmail(db(), uid(), input);
  return (row as { id: number }).id;
}

/**
 * Insert an app-side draft (email_drafts). The free-tier fallback for
 * create_email_draft, which cannot call Gmail's drafts.create (no gmail.modify).
 * Same shared insert as POST /api/gmail/drafts. Returns the new draft id.
 */
export async function createAppDraft(input: {
  to: string;
  subject: string;
  bodyHtml: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  contactName?: string;
}): Promise<number> {
  const row = await insertEmailDraft(db(), uid(), input);
  return (row as { id: number }).id;
}

export async function listScheduled() {
  const [scheduledRes, followUpsRes] = await Promise.all([
    db()
      .from("scheduled_emails")
      .select("id, recipient_email, subject, scheduled_send_at, thread_id, contact_name, matched_contact_id")
      .eq("user_id", uid())
      .eq("status", "pending")
      .order("scheduled_send_at", { ascending: true }),
    db()
      .from("email_follow_ups")
      .select("id, recipient_email, contact_name, original_subject, original_sent_at, thread_id, email_follow_up_messages(id, sequence_number, subject, status, scheduled_send_at)")
      .eq("user_id", uid())
      .eq("status", "active")
      .order("created_at", { ascending: false }),
  ]);
  if (scheduledRes.error) throw scheduledRes.error;
  if (followUpsRes.error) throw followUpsRes.error;

  const followUps = (followUpsRes.data ?? []).map((fu) => {
    const pending = (fu.email_follow_up_messages ?? [])
      // Open steps: pending auto-send or awaiting the user's confirm (CAR-102).
      .filter((m: { status: string }) => m.status === "pending" || m.status === "awaiting_review")
      .sort((a: { scheduled_send_at: string }, b: { scheduled_send_at: string }) =>
        a.scheduled_send_at.localeCompare(b.scheduled_send_at));
    return {
      follow_up_id: fu.id,
      recipient_email: fu.recipient_email,
      contact_name: fu.contact_name,
      original_subject: fu.original_subject,
      thread_id: fu.thread_id,
      pending_messages: pending.length,
      next_send_at: pending[0]?.scheduled_send_at ?? null,
    };
  });

  return { scheduledEmails: scheduledRes.data ?? [], followUpSequences: followUps };
}

export async function cancelScheduledEmail(scheduledEmailId: number): Promise<void> {
  // Shared CAS + linked follow-up teardown — the same cascade the web DELETE
  // route runs (CAR-136/CAR-151). Cancels pending AND failed rows, matching
  // the web behavior.
  const cancelled = await cancelScheduledEmailCascade(db(), uid(), scheduledEmailId);
  if (!cancelled) {
    throw new Error(`No cancellable scheduled email with id ${scheduledEmailId} — it may already be sending or sent`);
  }
}

export async function cancelFollowUpSequence(followUpId: number): Promise<void> {
  // Shared active-only cascade — the same teardown the web DELETE routes run
  // (CAR-151): parent CAS first (count-based, rule 17), then every unresolved
  // message.
  const cancelled = await cancelFollowUpSequenceCascade(db(), uid(), followUpId);
  if (!cancelled) {
    throw new Error(`No active follow-up sequence with id ${followUpId}`);
  }
}

/** Locate the original outbound message a follow-up sequence hangs off. */
export async function findOriginalOutbound(ref: { threadId?: string; messageId?: string }) {
  let q = db()
    .from("email_messages")
    .select("gmail_message_id, thread_id, subject, date, to_addresses")
    .eq("user_id", uid())
    .eq("direction", "outbound")
    .eq("is_simulated", false)
    .order("date", { ascending: true })
    .limit(1);
  if (ref.messageId) q = q.eq("gmail_message_id", ref.messageId);
  else if (ref.threadId) q = q.eq("thread_id", ref.threadId);
  else throw new Error("Provide thread_id or original_message_id");
  const { data, error } = await q;
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("No cached outbound message found for that thread/message — sync Gmail first or pass a different id");
  return row as { gmail_message_id: string; thread_id: string | null; subject: string | null; date: string | null; to_addresses: string[] | null };
}

export async function insertFollowUpSequence(input: {
  originalGmailMessageId: string;
  threadId: string;
  recipientEmail: string;
  contactName: string | null;
  originalSubject: string | null;
  originalSentAt: string;
  messageRows: Array<TablesInsert<"email_follow_up_messages">>;
}): Promise<number> {
  // Shared parent+messages insert (with parent rollback on message failure) —
  // the same rows the web follow-up creation routes write (CAR-151).
  return insertFollowUpSequenceRows(
    db(),
    uid(),
    {
      originalGmailMessageId: input.originalGmailMessageId,
      threadId: input.threadId,
      recipientEmail: input.recipientEmail,
      contactName: input.contactName,
      originalSubject: input.originalSubject,
      originalSentAt: input.originalSentAt,
    },
    input.messageRows,
  );
}

// ── Dossier data bundle ────────────────────────────────────────────────

export interface DossierBundle {
  contact: Record<string, unknown>;
  interactions: Array<Record<string, unknown>>;
  interactionsTotal: number;
  meetings: Array<Record<string, unknown>>;
  meetingsTotal: number;
  emails: Array<Record<string, unknown>>;
  emailsTotal: number;
  openActionItems: Array<Record<string, unknown>>;
  completedActionItems: Array<Record<string, unknown>>;
  scheduledEmails: Array<Record<string, unknown>>;
  activeFollowUps: Array<Record<string, unknown>>;
}

export async function getDossierBundle(contactId: number, depth: "recent" | "full"): Promise<DossierBundle> {
  const limit = depth === "full" ? 1000 : 10;

  const contact = await getContactFull(contactId);
  const emailAddresses = ((contact as { contact_emails?: Array<{ email: string | null }> }).contact_emails ?? [])
    .map((e) => e.email)
    .filter(Boolean) as string[];

  const [
    interactionsRes,
    interactionsCountRes,
    meetingsRes,
    meetingsCountRes,
    emailsRes,
    emailsCountRes,
    actionItemsRes,
    completedRes,
    scheduledRes,
    followUpsRes,
  ] = await Promise.all([
    db()
      .from("interactions")
      .select("id, interaction_date, interaction_type, summary")
      .eq("contact_id", contactId)
      .order("interaction_date", { ascending: false })
      .limit(limit),
    db()
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId),
    // private_notes and user_id are deliberately NOT selected — this bundle
    // feeds the email-grounding dossier the model reads before drafting, and
    // private reminders must not bleed into generated outreach.
    db()
      .from("meeting_contacts")
      .select("meetings!inner(id, meeting_date, meeting_type, title, notes)")
      .eq("contact_id", contactId)
      .eq("meetings.user_id", uid()),
    db()
      .from("meeting_contacts")
      .select("contact_id, meetings!inner(user_id)", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("meetings.user_id", uid()),
    db()
      .from("email_messages")
      .select("gmail_message_id, thread_id, subject, snippet, date, direction")
      .eq("user_id", uid())
      .eq("matched_contact_id", contactId)
      .eq("is_simulated", false)
      .order("date", { ascending: false })
      .limit(limit),
    db()
      .from("email_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid())
      .eq("matched_contact_id", contactId)
      .eq("is_simulated", false),
    db()
      .from("action_item_contacts")
      // Defense-in-depth: scope the embedded action item to this user. action_item_contacts
      // has no user_id, so keying only on the owned contact_id would let a bad junction row
      // surface another user's action item inside the dossier the model reads before drafting
      // outreach (same shape as the CAR-133 calendar-link defense above). The inner join drops it.
      .select("follow_up_action_items!inner(id, title, description, due_at, is_completed, completed_at, direction, snoozed_until, user_id)")
      .eq("contact_id", contactId)
      .eq("follow_up_action_items.user_id", uid()),
    db()
      .from("action_item_contacts")
      .select("follow_up_action_items!inner(id, title, completed_at, is_completed, user_id)")
      .eq("contact_id", contactId)
      .eq("follow_up_action_items.user_id", uid()),
    db()
      .from("scheduled_emails")
      .select("id, subject, scheduled_send_at, recipient_email")
      .eq("user_id", uid())
      .eq("matched_contact_id", contactId)
      .eq("status", "pending"),
    emailAddresses.length > 0
      ? db()
          .from("email_follow_ups")
          .select("id, recipient_email, original_subject, thread_id, email_follow_up_messages(sequence_number, status, scheduled_send_at, subject)")
          .eq("user_id", uid())
          .eq("status", "active")
          .in("recipient_email", emailAddresses)
      : Promise.resolve({ data: [], error: null } as { data: never[]; error: null }),
  ]);

  // user_id is selected only so the embed can be scoped (see the queries
  // above); strip it here so the dossier payload the model reads stays exactly
  // what it was — this bundle feeds generated outreach, and every field in it
  // is a field the model can quote.
  const stripUserId = <T extends { user_id?: unknown }>(i: T) => {
    const { user_id: _user_id, ...rest } = i;
    return rest;
  };
  const openActionItems = (actionItemsRes.data ?? [])
    .map((r) => r.follow_up_action_items)
    .filter((i): i is NonNullable<typeof i> => i != null && !i.is_completed)
    .map(stripUserId);
  const completedActionItems = (completedRes.data ?? [])
    .map((r) => r.follow_up_action_items)
    .filter((i): i is NonNullable<typeof i> => i != null && Boolean(i.is_completed))
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))
    .slice(0, depth === "full" ? 1000 : 5)
    .map(stripUserId);

  const meetings = (meetingsRes.data ?? [])
    .map((r) => r.meetings)
    .filter(Boolean)
    .sort((a, b) => String(b.meeting_date ?? "").localeCompare(String(a.meeting_date ?? "")))
    .slice(0, limit);

  return {
    contact: contact as Record<string, unknown>,
    interactions: (interactionsRes.data ?? []) as Array<Record<string, unknown>>,
    interactionsTotal: interactionsCountRes.count ?? 0,
    meetings,
    meetingsTotal: meetingsCountRes.count ?? 0,
    emails: (emailsRes.data ?? []) as Array<Record<string, unknown>>,
    emailsTotal: emailsCountRes.count ?? 0,
    openActionItems,
    completedActionItems,
    scheduledEmails: (scheduledRes.data ?? []) as Array<Record<string, unknown>>,
    activeFollowUps: (followUpsRes.data ?? []) as Array<Record<string, unknown>>,
  };
}

// ── Calendar ───────────────────────────────────────────────────────────

export async function listCalendarEvents(timeMin: string, timeMax: string) {
  const { data, error } = await db()
    .from("calendar_events")
    .select("id, google_event_id, title, description, start_at, end_at, all_day, meet_link, zoom_link, status, attendees, contact_id")
    .eq("user_id", uid())
    .gte("start_at", timeMin)
    .lt("start_at", timeMax)
    .neq("status", "cancelled")
    .order("start_at", { ascending: true });
  if (error) throw error;
  const events = data ?? [];

  // Attendee → contact matching via the shared email lookup (paginated,
  // user-scoped); projected down to {id, name} to keep the tool shape stable.
  const emailLookup = await getContactEmailLookup(uid());
  const byEmail = new Map<string, { id: number; name: string }>();
  for (const [email, contact] of emailLookup) {
    byEmail.set(email, { id: contact.id, name: contact.name });
  }

  const eventIds = events.map((e) => e.id);
  const linkRows = await chunked(eventIds, async (chunk) => {
    const { data: links } = await db()
      .from("calendar_event_contacts")
      // Defense-in-depth: scope the linked contact to this user. calendar_event_contacts
      // has no user_id, so an unscoped embed would surface a foreign contact's name if a
      // bad link ever landed here (CAR-133 / R2.1). The inner join drops any such link.
      .select("calendar_event_id, contact_id, contacts!inner(id, name, user_id)")
      .eq("contacts.user_id", uid())
      .in("calendar_event_id", chunk);
    return links ?? [];
  });
  const linksByEvent = new Map<number, Array<{ id: number; name: string }>>();
  for (const l of linkRows) {
    if (!l.contacts) continue;
    const list = linksByEvent.get(l.calendar_event_id) ?? [];
    // Project away the user_id the inner join required, so both match sources
    // (link rows and attendee lookup) contribute the same {id, name} shape.
    list.push({ id: l.contacts.id, name: l.contacts.name });
    linksByEvent.set(l.calendar_event_id, list);
  }

  return events.map((e) => {
    const matched = new Map<number, { id: number; name: string }>();
    for (const c of linksByEvent.get(e.id) ?? []) matched.set(c.id, c);
    for (const a of (e.attendees ?? []) as Array<{ email?: string }>) {
      const hit = a.email ? byEmail.get(a.email.toLowerCase()) : undefined;
      if (hit) matched.set(hit.id, hit);
    }
    return { ...e, matched_contacts: [...matched.values()] };
  });
}

export async function cacheCalendarEvent(input: {
  googleEventId: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  meetLink: string | null;
  attendeeEmails: string[];
  contactId: number;
}): Promise<void> {
  // Ownership assertion for the contact link below (calendar_event_contacts
  // has no user_id column) — don't trust the caller chain.
  await assertContactOwned(input.contactId);
  const { data, error } = await db()
    .from("calendar_events")
    .insert({
      user_id: uid(),
      google_event_id: input.googleEventId,
      calendar_id: "primary",
      title: input.title,
      description: input.description,
      start_at: new Date(input.startAt).toISOString(),
      end_at: new Date(input.endAt).toISOString(),
      all_day: false,
      location: null,
      meet_link: input.meetLink,
      zoom_link: null,
      status: "confirmed",
      attendees: input.attendeeEmails.map((email) => ({ email, name: email, responseStatus: "needsAction" })),
      is_private: null,
      recurring_event_id: null,
      contact_id: input.contactId,
      meeting_id: null,
      source_gmail_thread_id: null,
      source_gmail_message_id: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const eventRowId = (data as { id: number }).id;
  const { error: linkErr } = await db()
    .from("calendar_event_contacts")
    .insert({ calendar_event_id: eventRowId, contact_id: input.contactId });
  if (linkErr) throw linkErr;
}

// ── Companies ──────────────────────────────────────────────────────────

/** Resolve a company by id or name (name search is user-graph agnostic; ambiguity throws). */
export async function resolveCompanyId(ref: { company_id?: number; name?: string }): Promise<number> {
  if (ref.company_id != null) {
    const { data } = await db().from("companies").select("id").eq("id", ref.company_id).maybeSingle();
    if (!data) throw new Error(`No company with id ${ref.company_id}`);
    return ref.company_id;
  }
  const name = ref.name?.trim();
  if (!name) throw new Error("Provide company_id or name");
  const { data: exact } = await db()
    .from("companies")
    .select("id, name")
    .ilike("name", escapeIlike(name))
    .limit(10);
  if (exact?.length === 1) return (exact[0] as { id: number }).id;
  if ((exact?.length ?? 0) > 1) throw companyAmbiguity(name, exact as Array<{ id: number; name: string }>);
  const { data: fuzzy } = await db()
    .from("companies")
    .select("id, name")
    .ilike("name", `%${escapeIlike(name)}%`)
    .limit(10);
  if (fuzzy?.length === 1) return (fuzzy[0] as { id: number }).id;
  if ((fuzzy?.length ?? 0) > 1) throw companyAmbiguity(name, fuzzy as Array<{ id: number; name: string }>);
  throw new Error(`No company matches "${name}"`);
}

function companyAmbiguity(name: string, candidates: Array<{ id: number; name: string }>): Error {
  const list = candidates.map((c) => `  - ${c.name} (id ${c.id})`).join("\n");
  return new Error(`"${name}" matches ${candidates.length} companies — retry with company_id:\n${list}`);
}

export async function getOrCreateTargetCompany(companyId: number): Promise<number> {
  const { data } = await db()
    .from("target_companies")
    .select("id")
    .eq("user_id", uid())
    .eq("company_id", companyId)
    .is("location_id", null)
    .maybeSingle();
  if (data) return (data as { id: number }).id;
  const { data: created, error } = await db()
    .from("target_companies")
    .insert({
      user_id: uid(),
      company_id: companyId,
      priority_score: null,
      tier: null,
      program_name: null,
      app_window_text: null,
      next_app_date: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (created as { id: number }).id;
}

export async function addTargetCompanyNote(targetCompanyId: number, note: string, locationId: number | null): Promise<void> {
  // Ownership assertion: target_company_notes has no user_id column, so the
  // parent target row must be verified as the operating user's first.
  const { data: target, error: targetErr } = await db()
    .from("target_companies")
    .select("id")
    .eq("id", targetCompanyId)
    .eq("user_id", uid())
    .maybeSingle();
  if (targetErr) throw targetErr;
  if (!target) throw new Error(`No target company with id ${targetCompanyId}`);

  const { error } = await db()
    .from("target_company_notes")
    .insert({ target_company_id: targetCompanyId, note, location_id: locationId });
  if (error) throw error;
}

/** Company display name (companies is a global, cross-user table). */
export async function getCompanyName(companyId: number): Promise<string | null> {
  const { data, error } = await db()
    .from("companies")
    .select("name")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  return (data as { name: string } | null)?.name ?? null;
}
