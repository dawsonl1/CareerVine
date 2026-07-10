/**
 * Service-role data layer for the MCP server.
 *
 * The app's queries.ts is built on the browser client (anon key + user
 * session + RLS) and can't run in a Node process, so the reads/writes
 * the tools need are reimplemented here — compact, and with EVERY query
 * explicitly scoped to the single operating user (plan 26). Contact- and
 * item-referencing writes verify ownership first: the service role
 * bypasses RLS, so scoping is this module's job.
 *
 * company-queries.ts is reused directly (its queries are all
 * userId-parameterized) via setCompanyQueriesClient() injection.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { setCompanyQueriesClient } from "@/lib/company-queries";
import { escapeIlike, findOrCreateCompany, findOrCreateLocation } from "@/lib/company-helpers";
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
  const requestUser = currentUserIdOrNull();
  if (requestUser) return requestUser;
  if (stdioUserId) return stdioUserId;
  throw new Error("db not initialized — call initDb() or run inside runWithUser()");
}

/** Chunk .in() filters — PostgREST URLs blow up past a few hundred ids. */
async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...(await fn(ids.slice(i, i + 200))));
  }
  return out;
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

/** The same relation embed shape the app's getContactById uses. */
const CONTACT_FULL_EMBED = `
  *,
  locations(*),
  contact_emails(*),
  contact_phones(*),
  contact_companies(*, companies(*)),
  contact_schools(*, schools(*)),
  contact_tags(*, tags(*))
`;

export async function getContactFull(contactId: number) {
  const { data, error } = await db()
    .from("contacts")
    .select(CONTACT_FULL_EMBED)
    .eq("user_id", uid())
    .eq("id", contactId)
    .single();
  if (error) throw error;
  return data;
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
 * bulk imports push counts past PostgREST's 1000-row cap).
 */
export async function fetchSearchRows(tiers?: string[]): Promise<SearchRow[]> {
  const statuses = tiers?.length ? tiers : ["active", "prospect", "bench"];
  const PAGE = 1000;
  const all: SearchRow[] = [];
  for (let from = 0; ; from += PAGE) {
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
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data as unknown as SearchRow[]) ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

/** Latest touch (meeting or logged interaction) per contact. */
export async function buildLastTouchMap(contactIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (contactIds.length === 0) return map;

  const [meetingLinks, interactions] = await Promise.all([
    chunked(contactIds, async (chunk) => {
      const { data } = await db()
        .from("meeting_contacts")
        .select("contact_id, meetings!inner(user_id, meeting_date)")
        .eq("meetings.user_id", uid())
        .in("contact_id", chunk);
      return (data as unknown as Array<{ contact_id: number; meetings: { meeting_date: string | null } }>) ?? [];
    }),
    chunked(contactIds, async (chunk) => {
      const { data } = await db()
        .from("interactions")
        .select("contact_id, interaction_date")
        .in("contact_id", chunk);
      return (data as Array<{ contact_id: number; interaction_date: string | null }>) ?? [];
    }),
  ]);

  for (const ml of meetingLinks) {
    const date = ml.meetings?.meeting_date;
    if (!date) continue;
    const prev = map.get(ml.contact_id);
    if (!prev || date > prev) map.set(ml.contact_id, date);
  }
  for (const i of interactions) {
    if (!i.interaction_date) continue;
    const prev = map.get(i.contact_id);
    if (!prev || i.interaction_date > prev) map.set(i.contact_id, i.interaction_date);
  }
  return map;
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
  let locationId: number | null = null;
  if (input.location) {
    const loc = await findOrCreateLocation(db(), {
      city: input.location.city ?? null,
      state: input.location.state ?? null,
      country: input.location.country,
    });
    locationId = loc.id;
  }

  const { data: contact, error } = await db()
    .from("contacts")
    .insert({
      user_id: uid(),
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
    })
    .select("id")
    .single();
  if (error) throw error;
  const contactId = (contact as { id: number }).id;

  // The contact row is already committed; the child inserts below are not
  // transactional (Supabase JS has no client-side transaction). If any child
  // fails, roll back by deleting the contact so a retry doesn't orphan a
  // partial/duplicate contact. Cascade FKs clean up any children written so far.
  try {
    for (const [i, email] of (input.emails ?? []).entries()) {
      const { error: e } = await db()
        .from("contact_emails")
        .insert({ contact_id: contactId, email: email.trim().toLowerCase(), is_primary: i === 0 });
      if (e) throw e;
    }
    for (const [i, p] of (input.phones ?? []).entries()) {
      const { error: e } = await db()
        .from("contact_phones")
        .insert({ contact_id: contactId, phone: p.phone, type: p.type ?? "mobile", is_primary: i === 0 });
      if (e) throw e;
    }
    if (input.company?.name) {
      const company = await findOrCreateCompany(db(), { name: input.company.name });
      const { error: e } = await db().from("contact_companies").insert({
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
      if (e) throw e;
    }
    if (input.school?.name) {
      const schoolId = await findOrCreateSchool(input.school.name);
      const { error: e } = await db().from("contact_schools").insert({
        contact_id: contactId,
        school_id: schoolId,
        degree: input.school.degree ?? null,
        field_of_study: input.school.field_of_study ?? null,
        start_year: null,
        end_year: null,
      });
      if (e) throw e;
    }
  } catch (childErr) {
    await db().from("contacts").delete().eq("id", contactId).eq("user_id", uid());
    throw childErr;
  }

  // Assistant-created contacts count toward the contacts funnel and the
  // contacts_5 milestone like every other surface (CAR-58 audit: this path
  // was invisible, so AI-driven users looked like they never activated).
  await trackServer(uid(), "contact_imported", { source: "mcp" }, "mcp");
  await checkContactMilestone(uid());

  return contactId;
}

async function findOrCreateSchool(name: string): Promise<number> {
  const { data: existing } = await db()
    .from("schools")
    .select("id")
    .ilike("name", escapeIlike(name.trim()))
    .limit(1);
  if (existing?.[0]) return (existing[0] as { id: number }).id;
  const { data, error } = await db()
    .from("schools")
    .insert({ name: name.trim() })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

export async function appendNote(contactId: number, note: string): Promise<void> {
  await assertContactOwned(contactId);
  const { error } = await db().rpc("append_contact_note", {
    p_contact_id: contactId,
    p_note: note,
  });
  if (error) throw error;
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
  const { data, error } = await db()
    .from("follow_up_action_items")
    .insert({
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
    })
    .select("id")
    .single();
  if (error) throw error;
  const itemId = (data as { id: number }).id;
  if (input.contactIds.length > 0) {
    const { error: junctionErr } = await db()
      .from("action_item_contacts")
      .insert(input.contactIds.map((cid) => ({ action_item_id: itemId, contact_id: cid })));
    if (junctionErr) throw junctionErr;
  }
  return itemId;
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
  let query = db()
    .from("follow_up_action_items")
    .select("id, title, description, due_at, is_completed, completed_at, created_at, direction, snoozed_until, action_item_contacts(contact_id, contacts(id, name))")
    .eq("user_id", uid())
    .eq("is_completed", false)
    .or(`snoozed_until.is.null,snoozed_until.lt.${now.toISOString()}`)
    .order("due_at", { ascending: true, nullsFirst: false });
  if (opts.direction) query = query.eq("direction", opts.direction);
  const { data, error } = await query;
  if (error) throw error;
  let items = (data as unknown as ActionItemRow[]) ?? [];

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

const RECENTLY_ADDED_DAYS = 7;

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

/** Port of the app's getContactsDueForFollowUp (active tier only). */
export async function listDueFollowUps(): Promise<DueFollowUp[]> {
  const now = new Date().toISOString();
  const recentCutoffDate = new Date();
  recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENTLY_ADDED_DAYS);
  const recentCutoff = recentCutoffDate.toISOString();

  const { data: contacts, error } = await db()
    .from("contacts")
    .select("id, name, industry, follow_up_frequency_days, created_at, first_outreach_skipped, contact_emails(email)")
    .eq("user_id", uid())
    .eq("network_status", "active")
    .or(`reach_out_snoozed_until.is.null,reach_out_snoozed_until.lt.${now}`)
    .order("name");
  if (error) throw error;
  if (!contacts || contacts.length === 0) return [];

  const lastTouchMap = await buildLastTouchMap(contacts.map((c) => c.id));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return contacts
    .map((c) => {
      const lastTouch = lastTouchMap.get(c.id) ?? null;
      const neverContacted = !lastTouch;
      const freqDays = c.follow_up_frequency_days;
      const isRecent = c.created_at >= recentCutoff;
      const emails = ((c as { contact_emails?: Array<{ email: string | null }> }).contact_emails ?? [])
        .map((e) => e.email)
        .filter(Boolean);

      if (neverContacted && (isRecent || c.first_outreach_skipped)) return null;

      if (!freqDays) {
        if (!neverContacted || !isRecent) {
          return {
            id: c.id,
            name: c.name,
            industry: c.industry,
            follow_up_frequency_days: 0,
            last_touch: lastTouch,
            days_overdue: 0,
            never_contacted: neverContacted,
            no_cadence: true,
            has_email: emails.length > 0,
          };
        }
        return null;
      }

      const baseDate = neverContacted ? new Date(c.created_at) : new Date(lastTouch!);
      const dueDate = new Date(baseDate);
      dueDate.setDate(dueDate.getDate() + freqDays);
      const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / 86400_000);
      if (daysOverdue < 0) return null;

      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        follow_up_frequency_days: freqDays,
        last_touch: lastTouch,
        days_overdue: daysOverdue,
        never_contacted: neverContacted,
        no_cadence: false,
        has_email: emails.length > 0,
      };
    })
    .filter((c): c is DueFollowUp => c !== null)
    .sort((a, b) => {
      if (a.no_cadence !== b.no_cadence) return a.no_cadence ? 1 : -1;
      return b.days_overdue - a.days_overdue;
    });
}

// ── Network health ─────────────────────────────────────────────────────

export async function getNetworkHealth() {
  const tiers = ["active", "prospect", "bench"] as const;
  const tierResults = await Promise.all(
    tiers.map((tier) =>
      db()
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", uid())
        .eq("network_status", tier),
    ),
  );
  const tierCounts = {
    active: tierResults[0].count ?? 0,
    prospect: tierResults[1].count ?? 0,
    bench: tierResults[2].count ?? 0,
  };

  // On-track ratio (port of getRelationshipsOnTrack, active tier)
  const recentCutoffDate = new Date();
  recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENTLY_ADDED_DAYS);
  const recentCutoff = recentCutoffDate.toISOString();
  const { data: contacts, error } = await db()
    .from("contacts")
    .select("id, name, follow_up_frequency_days, created_at, first_outreach_skipped")
    .eq("user_id", uid())
    .eq("network_status", "active");
  if (error) throw error;

  const lastTouchMap = await buildLastTouchMap((contacts ?? []).map((c) => c.id));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let onTrack = 0;
  let total = 0;
  const neglected: Array<{ id: number; name: string; days_since_touch: number | null; cadence_days: number }> = [];
  for (const c of contacts ?? []) {
    if (c.first_outreach_skipped) continue;
    const lastTouch = lastTouchMap.get(c.id);
    const isRecent = c.created_at >= recentCutoff;
    if (!lastTouch && isRecent) continue;
    total++;

    const baseDate = lastTouch ? new Date(lastTouch) : new Date(c.created_at);
    const daysSince = Math.floor((today.getTime() - baseDate.getTime()) / 86400_000);
    if (c.follow_up_frequency_days) {
      // Match the app's getRelationshipsOnTrack: contacted contacts compare
      // whole-day elapsed vs cadence; never-contacted-with-cadence compare
      // today against created_at + cadence (keeps the created time-of-day, so
      // the two surfaces don't disagree by a day at sub-day boundaries).
      let onTrackHere: boolean;
      if (lastTouch) {
        onTrackHere = daysSince <= c.follow_up_frequency_days;
      } else {
        const dueDate = new Date(c.created_at);
        dueDate.setDate(dueDate.getDate() + c.follow_up_frequency_days);
        onTrackHere = today <= dueDate;
      }
      if (onTrackHere) onTrack++;
    }
    if (c.follow_up_frequency_days && daysSince >= c.follow_up_frequency_days * 2) {
      neglected.push({
        id: c.id,
        name: c.name,
        days_since_touch: lastTouch ? daysSince : null,
        cadence_days: c.follow_up_frequency_days,
      });
    }
  }
  neglected.sort((a, b) => (b.days_since_touch ?? 9999) - (a.days_since_touch ?? 9999));

  // Streak (port of getNetworkingStreak)
  const lookback = new Date(today);
  lookback.setDate(lookback.getDate() - 365);
  const lookbackStr = lookback.toISOString().split("T")[0];
  const [meetingsRes, completedRes, interactionsRes] = await Promise.all([
    db().from("meetings").select("meeting_date").eq("user_id", uid()).gte("meeting_date", lookbackStr),
    db().from("follow_up_action_items").select("completed_at").eq("user_id", uid()).eq("is_completed", true).gte("completed_at", lookback.toISOString()),
    db().from("interactions").select("interaction_date, contacts!inner(user_id)").eq("contacts.user_id", uid()).gte("interaction_date", lookbackStr),
  ]);
  const activeDays = new Set<string>();
  for (const m of meetingsRes.data ?? []) if (m.meeting_date) activeDays.add(m.meeting_date.split("T")[0]);
  for (const a of completedRes.data ?? []) if (a.completed_at) activeDays.add(a.completed_at.split("T")[0]);
  for (const i of interactionsRes.data ?? []) if (i.interaction_date) activeDays.add(i.interaction_date.split("T")[0]);

  let streak = 0;
  const check = new Date(today);
  if (activeDays.has(today.toISOString().split("T")[0])) streak = 1;
  check.setDate(check.getDate() - 1);
  while (activeDays.has(check.toISOString().split("T")[0])) {
    streak++;
    check.setDate(check.getDate() - 1);
  }

  // Last-30-day activity totals
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [m30, i30, e30, a30] = await Promise.all([
    db().from("meetings").select("id", { count: "exact", head: true }).eq("user_id", uid()).gte("meeting_date", thirtyAgo.split("T")[0]),
    db().from("interactions").select("id, contacts!inner(user_id)", { count: "exact", head: true }).eq("contacts.user_id", uid()).gte("interaction_date", thirtyAgo.split("T")[0]),
    db().from("email_messages").select("id", { count: "exact", head: true }).eq("user_id", uid()).eq("direction", "outbound").eq("is_simulated", false).gte("date", thirtyAgo),
    db().from("follow_up_action_items").select("id", { count: "exact", head: true }).eq("user_id", uid()).eq("is_completed", true).gte("completed_at", thirtyAgo),
  ]);

  return {
    tierCounts,
    onTrack: {
      percentage: total > 0 ? Math.round((onTrack / total) * 100) : 100,
      onTrack,
      total,
    },
    streakDays: streak,
    neglectedContacts: neglected.slice(0, 15),
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

export async function getEmailsForContact(contactId: number, limit: number) {
  const { data, error } = await db()
    .from("email_messages")
    .select("gmail_message_id, thread_id, subject, snippet, date, direction")
    .eq("user_id", uid())
    .eq("matched_contact_id", contactId)
    .eq("is_simulated", false)
    .order("date", { ascending: false })
    .limit(limit);
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
  const { data, error } = await db()
    .from("scheduled_emails")
    .insert({
      user_id: uid(),
      recipient_email: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      subject: input.subject,
      body_html: input.bodyHtml,
      thread_id: input.threadId ?? null,
      in_reply_to: input.inReplyTo ?? null,
      references_header: input.references ?? null,
      scheduled_send_at: input.scheduledSendAt,
      status: "pending",
      sent_at: null,
      gmail_message_id: null,
      sent_thread_id: null,
      contact_name: input.contactName ?? null,
      matched_contact_id: input.matchedContactId ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
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
      .filter((m: { status: string }) => m.status === "pending")
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
  const { data, error } = await db()
    .from("scheduled_emails")
    .update({ status: "cancelled_user", updated_at: new Date().toISOString() })
    .eq("id", scheduledEmailId)
    .eq("user_id", uid())
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`No pending scheduled email with id ${scheduledEmailId}`);
  }
}

export async function cancelFollowUpSequence(followUpId: number): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("email_follow_ups")
    .update({ status: "cancelled_user", updated_at: now })
    .eq("id", followUpId)
    .eq("user_id", uid())
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`No active follow-up sequence with id ${followUpId}`);
  }
  const { error: msgError } = await db()
    .from("email_follow_up_messages")
    .update({ status: "cancelled" })
    .eq("follow_up_id", followUpId)
    .eq("status", "pending");
  if (msgError) throw msgError;
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
  messageRows: Array<Record<string, unknown>>;
}): Promise<number> {
  const { data: followUp, error } = await db()
    .from("email_follow_ups")
    .insert({
      user_id: uid(),
      original_gmail_message_id: input.originalGmailMessageId,
      thread_id: input.threadId,
      recipient_email: input.recipientEmail,
      contact_name: input.contactName,
      original_subject: input.originalSubject,
      original_sent_at: input.originalSentAt,
      status: "active",
      scheduled_email_id: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const followUpId = (followUp as { id: number }).id;
  const rows = input.messageRows.map((r) => ({ ...r, follow_up_id: followUpId }));
  const { error: msgError } = await db().from("email_follow_up_messages").insert(rows);
  if (msgError) throw msgError;
  return followUpId;
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
      .select("follow_up_action_items(id, title, description, due_at, is_completed, completed_at, direction, snoozed_until)")
      .eq("contact_id", contactId),
    db()
      .from("action_item_contacts")
      .select("follow_up_action_items(id, title, completed_at, is_completed)")
      .eq("contact_id", contactId),
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

  const openActionItems = ((actionItemsRes.data ?? []) as unknown as Array<{ follow_up_action_items: Record<string, unknown> | null }>)
    .map((r) => r.follow_up_action_items)
    .filter((i): i is Record<string, unknown> => Boolean(i) && !(i as { is_completed?: boolean }).is_completed);
  const completedActionItems = ((completedRes.data ?? []) as unknown as Array<{ follow_up_action_items: Record<string, unknown> | null }>)
    .map((r) => r.follow_up_action_items)
    .filter((i): i is Record<string, unknown> => Boolean(i) && Boolean((i as { is_completed?: boolean }).is_completed))
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))
    .slice(0, depth === "full" ? 1000 : 5);

  const meetings = ((meetingsRes.data ?? []) as unknown as Array<{ meetings: Record<string, unknown> }>)
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

  // Attendee → contact matching (same idea as the home page)
  const { data: emailRows } = await db()
    .from("contact_emails")
    .select("email, contact_id, contacts!inner(id, name, user_id)")
    .eq("contacts.user_id", uid());
  const byEmail = new Map<string, { id: number; name: string }>();
  for (const row of (emailRows ?? []) as unknown as Array<{ email: string | null; contacts: { id: number; name: string } }>) {
    if (row.email && row.contacts) byEmail.set(row.email.toLowerCase(), row.contacts);
  }

  const eventIds = events.map((e) => e.id);
  const linkRows = await chunked(eventIds, async (chunk) => {
    const { data: links } = await db()
      .from("calendar_event_contacts")
      .select("calendar_event_id, contact_id, contacts(id, name)")
      .in("calendar_event_id", chunk);
    return (links as unknown as Array<{ calendar_event_id: number; contacts: { id: number; name: string } | null }>) ?? [];
  });
  const linksByEvent = new Map<number, Array<{ id: number; name: string }>>();
  for (const l of linkRows) {
    if (!l.contacts) continue;
    const list = linksByEvent.get(l.calendar_event_id) ?? [];
    list.push(l.contacts);
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
  const { error } = await db()
    .from("target_company_notes")
    .insert({ target_company_id: targetCompanyId, note, location_id: locationId });
  if (error) throw error;
}
