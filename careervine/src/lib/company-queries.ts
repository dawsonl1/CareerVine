/**
 * Company-page data layer (plan 24 Phase 3).
 *
 * getCompanies powers /companies (target dashboard + all-companies search);
 * getCompanyDetail powers /companies/[id] with location facets and the
 * current/former/bench split. Bench containment is enforced here: bench
 * people are returned in their own list, never mixed into contact counts
 * or traction.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import {
  deriveOutreachStage,
  stageRank,
  type OutreachStage,
  type StageSignals,
} from "./stage-derivation";
import { chunked, paginateAll, escapeIlike } from "@/lib/data/postgrest";
import { must } from "@/lib/data/client";
import { findOrCreateCompany } from "./company-helpers";
import { nextActionForCompany } from "./company-next-action";

type QueryClient = ReturnType<typeof createSupabaseBrowserClient>;

// Client is resolved lazily so this module can run outside the browser:
// the MCP server injects a service-role client (all queries here are
// explicitly user_id-scoped, so bypassing RLS is safe); the app falls
// back to the usual browser singleton on first use.
let injectedClient: QueryClient | null = null;
let browserClient: QueryClient | null = null;

export function setCompanyQueriesClient(client: QueryClient) {
  injectedClient = client;
}

function db(): QueryClient {
  if (injectedClient) return injectedClient;
  if (!browserClient) browserClient = createSupabaseBrowserClient();
  return browserClient;
}

// ── Shared helpers ─────────────────────────────────────────────────────

/** Pipeline personas that count as "in a product role" for the product-alum signal. */
export const PRODUCT_PERSONAS = new Set(["product_leader", "alum_product", "product_peer"]);

/** Schools that light the alum badge (extend as review shows gaps). */
export function isByuSchoolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.includes("brigham young") || n.startsWith("byu");
}

/**
 * Batch-resolve which of the given contacts have a BYU school on file
 * (contact_schools → schools.name match). Complements contacts.verified_school
 * for the who-you-know alum signal on the companies list.
 */
async function byuAlumContactIds(contactIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (contactIds.length === 0) return out;
  const rows = await chunked(contactIds, async (chunk) => {
    return (
      must(await db().from("contact_schools").select("contact_id, schools(name)").in("contact_id", chunk)) ?? []
    );
  });
  for (const s of rows) {
    if (s.schools?.name && isByuSchoolName(s.schools.name)) out.add(s.contact_id);
  }
  return out;
}

// ── Stage signals (batch) ──────────────────────────────────────────────

export interface ContactStage {
  stage: OutreachStage;
  rank: number;
}

/**
 * Batch-derive outreach stages for a set of contacts. ~6 queries total
 * regardless of contact count.
 */
export async function getContactStages(
  userId: string,
  contacts: Array<{ id: number; stage_override?: string | null }>,
): Promise<Map<number, ContactStage>> {
  const result = new Map<number, ContactStage>();
  if (contacts.length === 0) return result;
  const ids = contacts.map((c) => c.id);
  const nowIso = new Date().toISOString();

  const [emails, contactAddrs, interactions, referrals, bounces, calEvents, calLinks, meetingLinks] = await Promise.all([
    chunked(ids, async (chunk) =>
      // Junction-scoped (CAR-159), mirroring the calendar_event_contacts leg
      // below: a shared thread contributes signals to EVERY linked contact,
      // not just the single matched_contact_id. from_address is selected so the
      // aggregation can credit an inbound REPLY only to its actual sender, not
      // to cc'd co-recipients (see the aggregation loop). Paginated: the
      // junction returns one row per (message, contact) link, so a 200-contact
      // chunk of a heavy emailer can exceed PostgREST's 1000-row cap.
      //
      // must() per page (CAR-158), matching every other leg here: a dropped
      // page is indistinguishable from "this contact has no email signal", and
      // deriveStage would then compute an earlier stage from partial evidence,
      // putting an already-contacted person back into outreach queues.
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("email_message_contacts")
            .select("contact_id, email_messages!inner(user_id, direction, date, from_address, is_simulated)")
            .eq("email_messages.user_id", userId)
            .eq("email_messages.is_simulated", false)
            .in("contact_id", chunk)
            .order("email_message_id")
            .order("contact_id")
            .range(from, to),
        ) ?? [],
      ),
    ),
    chunked(ids, async (chunk) =>
      // Contact address sets (CAR-159): used to attribute an inbound reply to
      // the contact who actually sent it. Explicitly user-scoped via the
      // contacts!inner embed (safe under the MCP service-role client).
      //
      // must() (CAR-158): an empty address set silently fails the sender gate
      // below, so a dropped read would stop EVERY inbound reply from crediting
      // its contact — the same "never reaches replied" failure the gate itself
      // is designed to avoid.
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("contact_emails")
            .select("contact_id, email, contacts!inner()")
            .eq("contacts.user_id", userId)
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ) ?? [],
      ),
    ),
    chunked(ids, async (chunk) => {
      // Explicitly user-scoped (CAR-151): this also runs under the MCP
      // service-role client, where RLS doesn't filter foreign interactions.
      return (
        must(
          await db()
            .from("interactions")
            .select("contact_id, contacts!inner()")
            .eq("contacts.user_id", userId)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        must(
          await db()
            .from("referrals")
            .select("referred_by_contact_id")
            .eq("user_id", userId)
            .in("referred_by_contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      // Explicitly user-scoped (CAR-151), same reason as the interactions leg.
      return (
        must(
          await db()
            .from("contact_emails")
            .select("contact_id, contacts!inner()")
            .eq("contacts.user_id", userId)
            .not("bounced_at", "is", null)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        must(
          await db()
            .from("calendar_events")
            .select("contact_id, start_at, status")
            .eq("user_id", userId)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        must(
          await db()
            .from("calendar_event_contacts")
            .select("contact_id, calendar_events!inner(user_id, start_at, status)")
            .eq("calendar_events.user_id", userId)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        must(
          await db()
            .from("meeting_contacts")
            .select("contact_id, meetings!inner(user_id, meeting_date)")
            .eq("meetings.user_id", userId)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
  ]);

  // Contact -> normalized address set, for inbound sender attribution.
  const addrByContact = new Map<number, Set<string>>();
  for (const r of contactAddrs as Array<{ contact_id: number; email: string | null }>) {
    if (!r.email) continue;
    const set = addrByContact.get(r.contact_id) ?? new Set<string>();
    set.add(r.email.toLowerCase()); // contact_emails.email is already lower(trim())'d
    addrByContact.set(r.contact_id, set);
  }

  // Aggregate signals per contact
  const outboundAt = new Map<number, string>(); // earliest outbound date
  const inboundAt = new Map<number, string[]>();
  for (const link of emails as Array<{ contact_id: number; email_messages: { direction: string | null; date: string | null; from_address: string | null } | null }>) {
    const m = link.email_messages;
    if (m == null) continue;
    if (m.direction === "outbound") {
      // Outbound credits every linked contact — they all received the outreach.
      const prev = outboundAt.get(link.contact_id);
      const d = m.date ?? "";
      if (!prev || d < prev) outboundAt.set(link.contact_id, d);
    } else if (m.direction === "inbound") {
      // Inbound counts as a REPLY only for the contact who sent it (their
      // address is from_address), not for cc'd co-recipients who merely
      // received it. Without this, a reply-all on a shared thread would flip
      // every linked contact to stage "replied" and silence their follow-ups
      // (CAR-159 review F9). A message whose sender matches no linked contact
      // address (rare: sender address removed from the contact) is skipped.
      const from = (m.from_address ?? "").toLowerCase();
      if (from && addrByContact.get(link.contact_id)?.has(from)) {
        const list = inboundAt.get(link.contact_id) ?? [];
        list.push(m.date ?? "");
        inboundAt.set(link.contact_id, list);
      }
    }
  }

  const interacted = new Set((interactions as Array<{ contact_id: number }>).map((r) => r.contact_id));
  const referred = new Set((referrals as Array<{ referred_by_contact_id: number }>).map((r) => r.referred_by_contact_id));
  const bounced = new Set((bounces as Array<{ contact_id: number }>).map((r) => r.contact_id));

  const upcoming = new Set<number>();
  const past = new Set<number>();
  const noteEvent = (contactId: number | null, startAt: string | null, status: string | null) => {
    if (contactId == null || !startAt || status === "cancelled") return;
    (startAt > nowIso ? upcoming : past).add(contactId);
  };
  for (const e of calEvents) {
    noteEvent(e.contact_id, e.start_at, e.status);
  }
  for (const l of calLinks) {
    noteEvent(l.contact_id, l.calendar_events?.start_at ?? null, l.calendar_events?.status ?? null);
  }
  for (const l of meetingLinks) {
    const d = l.meetings?.meeting_date;
    if (!d) continue;
    (d > nowIso ? upcoming : past).add(l.contact_id);
  }

  for (const contact of contacts) {
    const firstOutbound = outboundAt.get(contact.id);
    const inbounds = inboundAt.get(contact.id) ?? [];
    const hasReply = Boolean(firstOutbound != null && inbounds.some((d) => d >= firstOutbound));
    const signals: StageSignals = {
      stageOverride: contact.stage_override ?? null,
      hasReferral: referred.has(contact.id),
      hasPastCall: past.has(contact.id),
      hasUpcomingCall: upcoming.has(contact.id),
      hasReply,
      hasOutboundEmail: firstOutbound != null,
      hasInteraction: interacted.has(contact.id),
      hasBouncedEmail: bounced.has(contact.id),
    };
    const stage = deriveOutreachStage(signals);
    result.set(contact.id, { stage, rank: stageRank(stage) });
  }
  return result;
}

// ── Companies dashboard ────────────────────────────────────────────────

export interface TargetInfo {
  id: number;
  priority_score: number | null;
  tier: string | null;
  program_name: string | null;
  app_window_text: string | null;
  next_app_date: string | null;
  status: string;
}

export interface OfficeScopeSummary {
  location_id: number;
  label: string;
  status: string;
}

export interface CompanySummary {
  id: number;
  name: string;
  logo_url: string | null;
  linkedin_url: string | null;
  current_count: number;
  former_count: number;
  bench_count: number;
  /** BYU alumni among current non-bench contacts — the app's warm-intro edge. */
  alum_count: number;
  /** BYU alumni among current non-bench contacts who are in a product role — the top intro for a PM search. */
  product_alum_count: number;
  /** Recruiters among current non-bench contacts. */
  recruiter_count: number;
  /**
   * The person to name in the next-action line: the highest-traction current
   * contact when there's momentum, else the best warm lead (alum first). Null
   * when the company has no current non-bench contacts.
   */
  lead_contact_name: string | null;
  target: TargetInfo | null;
  /** Targeted office scopes (location-level targets), highest priority first. */
  office_scopes: OfficeScopeSummary[];
  /** Max derived stage across non-bench contacts (pursuing/in_play views). */
  traction: OutreachStage | null;
}

/** One target_companies row (any scope, targeted or not) for derivation. */
export interface CompanyTargetScopeRow {
  id: number;
  location_id: number | null;
  is_targeted: boolean;
  priority_score: number | null;
  tier: string | null;
  program_name: string | null;
  app_window_text: string | null;
  next_app_date: string | null;
  status: string;
  location_label: string | null;
}

/**
 * Collapse a company's scope rows into what the dashboard card shows.
 *
 * The status chip follows the company-wide row when it's targeted, else
 * the highest-priority targeted office. Tier / program / window hint are
 * employer attributes (§18.12 Q5 Option C), so they come from the
 * company-wide row even when it's a soft-untargeted container. The app
 * date is the nearest across targeted scopes (deadlines drive action);
 * priority is the max, so list sorting sees the strongest scope.
 */
export function deriveCompanyTarget(rows: CompanyTargetScopeRow[]): {
  target: TargetInfo | null;
  office_scopes: OfficeScopeSummary[];
} {
  const companyWide = rows.find((r) => r.location_id == null) ?? null;
  const targetedOffices = rows
    .filter((r) => r.location_id != null && r.is_targeted)
    .sort(
      (a, b) =>
        (b.priority_score ?? -1) - (a.priority_score ?? -1) ||
        (a.location_label ?? "").localeCompare(b.location_label ?? ""),
    );

  const office_scopes: OfficeScopeSummary[] = targetedOffices.map((r) => ({
    location_id: r.location_id!,
    label: r.location_label ?? `Location ${r.location_id}`,
    status: r.status,
  }));

  const primary = companyWide?.is_targeted ? companyWide : targetedOffices[0] ?? null;
  if (!primary) return { target: null, office_scopes: [] };

  const targetedScopes = [
    ...(companyWide?.is_targeted ? [companyWide] : []),
    ...targetedOffices,
  ];
  const appDates = targetedScopes
    .map((r) => r.next_app_date)
    .filter((d): d is string => d != null)
    .sort();
  const priorities = targetedScopes
    .map((r) => r.priority_score)
    .filter((p): p is number => p != null);

  return {
    target: {
      id: primary.id,
      status: primary.status,
      tier: companyWide?.tier ?? primary.tier ?? null,
      program_name: companyWide?.program_name ?? primary.program_name ?? null,
      app_window_text: companyWide?.app_window_text ?? primary.app_window_text ?? null,
      next_app_date: appDates[0] ?? null,
      priority_score: priorities.length > 0 ? Math.max(...priorities) : null,
    },
    office_scopes,
  };
}

export type CompanySort = "next" | "priority" | "traction" | "next_app_date" | "name";

/**
 * Which companies the dashboard returns:
 * - `targets`  — only companies the user explicitly targets (outreach queue, MCP).
 * - `pursuing` — targets + companies where the user has a CURRENT *prospect*
 *                contact (someone intentionally put in the outreach funnel).
 *                The primary /companies view: everything you're actually
 *                working, without the noise of every imported contact's employer.
 * - `in_play`  — targets + companies where the user has ANY current non-bench
 *                contact (active or prospect). Broader; retained for callers
 *                that want the full "where I know someone" set.
 * - `all`      — every company with contacts (full network-history search).
 */
export type CompanyScope = "targets" | "pursuing" | "in_play" | "all";

/**
 * Pick which company ids a scope surfaces, given the user's targets and the
 * per-company current/former contact aggregate. Pure so the view semantics
 * are unit-testable without a database.
 *
 * - `targets`  — exactly the targeted companies.
 * - `pursuing` — targets ∪ companies with a CURRENT *prospect* contact.
 *                Intentional signals only: a prospect is someone you moved
 *                into the outreach funnel, so an imported `active` contact
 *                never drags its employer onto the list.
 * - `in_play`  — targets ∪ companies with ANY current contact (active or
 *                prospect). Current only, so a contact's past employers don't
 *                flood the list; bench is already excluded from `current`.
 * - `all`      — targets ∪ companies with ≥ `minContacts` current-or-former
 *                contacts.
 */
export function selectCompanyIds<
  A extends { current: { size: number }; former: { size: number }; currentProspect: { size: number } },
>(
  scope: CompanyScope,
  targetCompanyIds: Iterable<number>,
  aggByCompany: Map<number, A>,
  minContacts = 1,
): number[] {
  if (scope === "targets") return [...new Set(targetCompanyIds)];
  const ids = new Set<number>(targetCompanyIds);
  for (const [id, agg] of aggByCompany) {
    const qualifies =
      scope === "pursuing"
        ? agg.currentProspect.size >= 1
        : scope === "in_play"
          ? agg.current.size >= 1
          : agg.current.size + agg.former.size >= minContacts;
    if (qualifies) ids.add(id);
  }
  return [...ids];
}

interface EmploymentAggRow {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  contacts: {
    name: string;
    network_status: string;
    stage_override: string | null;
    persona: string | null;
    verified_school: string | null;
  };
}

async function fetchUserEmploymentRows(userId: string): Promise<EmploymentAggRow[]> {
  const PAGE = 1000;
  const all: EmploymentAggRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from("contact_companies")
      .select(
        "company_id, contact_id, is_current, contacts!inner(user_id, name, network_status, stage_override, persona, verified_school)",
      )
      .eq("contacts.user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

export async function getCompanies(
  userId: string,
  opts: { scope?: CompanyScope; search?: string; minContacts?: number; sort?: CompanySort } = {},
): Promise<CompanySummary[]> {
  const scope = opts.scope ?? "targets";
  // Default order: focused views lead with what needs you next; the full
  // search is alphabetical; the outreach/MCP targets queue stays priority-first.
  const sort = opts.sort ?? (scope === "all" ? "name" : scope === "targets" ? "priority" : "next");

  const [employment, targetsRes] = await Promise.all([
    fetchUserEmploymentRows(userId),
    // All scope rows, including soft-untargeted containers: tier/program
    // live on the company-wide row even when only offices are targeted.
    db()
      .from("target_companies")
      .select(
        "id, company_id, location_id, is_targeted, priority_score, tier, program_name, app_window_text, next_app_date, status, locations(city, state, country)",
      )
      .eq("user_id", userId),
  ]);
  if (targetsRes.error) throw targetsRes.error;
  const scopeRows = targetsRes.data ?? [];
  // A company is a target if ANY scope (company-wide or office) is targeted.
  const targetByCompany = new Map<number, ReturnType<typeof deriveCompanyTarget>>();
  {
    const rowsByCompany = new Map<number, CompanyTargetScopeRow[]>();
    for (const r of scopeRows) {
      const list = rowsByCompany.get(r.company_id) ?? [];
      list.push({ ...r, location_label: locationLabel(r.locations) });
      rowsByCompany.set(r.company_id, list);
    }
    for (const [companyId, rows] of rowsByCompany) {
      const derived = deriveCompanyTarget(rows);
      if (derived.target) targetByCompany.set(companyId, derived);
    }
  }

  // Aggregate people per company; bench counted separately, never mixed
  interface PersonAgg {
    id: number;
    name: string;
    stage_override: string | null;
    persona: string | null;
    verified_school: string | null;
    is_current: boolean;
  }
  interface Agg {
    current: Set<number>;
    former: Set<number>;
    bench: Set<number>;
    /** Current contacts intentionally put in the outreach funnel (network_status='prospect'). */
    currentProspect: Set<number>;
    /** Non-bench people at this company, deduped by contact id (current wins). */
    people: Map<number, PersonAgg>;
  }
  const aggByCompany = new Map<number, Agg>();
  for (const row of employment) {
    let agg = aggByCompany.get(row.company_id);
    if (!agg) {
      agg = {
        current: new Set(),
        former: new Set(),
        bench: new Set(),
        currentProspect: new Set(),
        people: new Map(),
      };
      aggByCompany.set(row.company_id, agg);
    }
    const contact = row.contacts;
    if (contact.network_status === "bench") {
      agg.bench.add(row.contact_id);
    } else {
      (row.is_current ? agg.current : agg.former).add(row.contact_id);
      if (row.is_current && contact.network_status === "prospect") agg.currentProspect.add(row.contact_id);
      const existing = agg.people.get(row.contact_id);
      if (existing) {
        // Same contact, multiple roles at this company — collapse; current wins.
        if (row.is_current) existing.is_current = true;
      } else {
        agg.people.set(row.contact_id, {
          id: row.contact_id,
          name: contact.name,
          stage_override: contact.stage_override,
          persona: contact.persona,
          verified_school: contact.verified_school,
          is_current: row.is_current,
        });
      }
    }
  }
  // A boomeranger is current, not former
  for (const agg of aggByCompany.values()) {
    for (const id of agg.current) agg.former.delete(id);
  }

  // Which companies to show
  const companyIds = selectCompanyIds(scope, targetByCompany.keys(), aggByCompany, opts.minContacts ?? 1);
  if (companyIds.length === 0) return [];

  // Company rows (chunked)
  const companyRows = await chunked(companyIds, async (chunk) => {
    let q = db()
      .from("companies")
      .select("id, name, logo_url, linkedin_url")
      .in("id", chunk);
    if (opts.search?.trim()) {
      q = q.ilike("name", `%${escapeIlike(opts.search.trim())}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  });

  // Enrichment (traction + who-you-know) per company. Skipped only for the
  // "all" view, whose company set is unbounded; targets/pursuing/in_play are
  // bounded and safe. One extra batched query (BYU alumni) over the shown set.
  const traction = new Map<number, OutreachStage>();
  const alumCountByCompany = new Map<number, number>();
  const productAlumCountByCompany = new Map<number, number>();
  const recruiterCountByCompany = new Map<number, number>();
  const leadNameByCompany = new Map<number, string | null>();
  if (scope !== "all") {
    const uniqueContacts = new Map<number, { id: number; stage_override: string | null }>();
    for (const id of companyIds) {
      for (const p of aggByCompany.get(id)?.people.values() ?? []) {
        uniqueContacts.set(p.id, { id: p.id, stage_override: p.stage_override });
      }
    }
    const [stages, byuByContact] = await Promise.all([
      getContactStages(userId, [...uniqueContacts.values()]),
      byuAlumContactIds([...uniqueContacts.keys()]),
    ]);
    const isAlum = (p: PersonAgg) =>
      byuByContact.has(p.id) || (p.verified_school != null && p.verified_school !== "none");
    // A BYU alum in a product role — the highest-value intro for a PM search.
    const isProductAlum = (p: PersonAgg) => isAlum(p) && PRODUCT_PERSONAS.has(p.persona ?? "");

    for (const id of companyIds) {
      const people = [...(aggByCompany.get(id)?.people.values() ?? [])];
      const current = people.filter((p) => p.is_current);
      alumCountByCompany.set(id, current.filter(isAlum).length);
      productAlumCountByCompany.set(id, current.filter(isProductAlum).length);
      recruiterCountByCompany.set(id, current.filter((p) => p.persona === "recruiter").length);

      // Max derived stage across non-bench, and the contact driving it.
      let best: { stage: ContactStage; person: PersonAgg } | null = null;
      for (const p of people) {
        const s = stages.get(p.id);
        if (s && (!best || s.rank > best.stage.rank)) best = { stage: s, person: p };
      }
      if (best) traction.set(id, best.stage.stage);

      // Lead name for the next-action line: the contact with real momentum, else
      // the best warm lead among current contacts (product alum → alum → recruiter → any).
      let lead: string | null = null;
      if (best && best.stage.rank > stageRank("not_contacted")) {
        lead = best.person.name;
      } else if (current.length > 0) {
        const warm =
          current.find(isProductAlum) ??
          current.find(isAlum) ??
          current.find((p) => p.persona === "recruiter") ??
          current[0];
        lead = warm.name;
      }
      leadNameByCompany.set(id, lead);
    }
  }

  const summaries: CompanySummary[] = (companyRows as Array<{
    id: number;
    name: string;
    logo_url: string | null;
    linkedin_url: string | null;
  }>).map((c) => {
    const agg = aggByCompany.get(c.id);
    const derived = targetByCompany.get(c.id);
    return {
      id: c.id,
      name: c.name,
      logo_url: c.logo_url,
      linkedin_url: c.linkedin_url,
      current_count: agg?.current.size ?? 0,
      former_count: agg?.former.size ?? 0,
      bench_count: agg?.bench.size ?? 0,
      alum_count: alumCountByCompany.get(c.id) ?? 0,
      product_alum_count: productAlumCountByCompany.get(c.id) ?? 0,
      recruiter_count: recruiterCountByCompany.get(c.id) ?? 0,
      lead_contact_name: leadNameByCompany.get(c.id) ?? null,
      target: derived?.target ?? null,
      office_scopes: derived?.office_scopes ?? [],
      traction: traction.get(c.id) ?? null,
    };
  });

  const cmpNullsLast = (a: number | string | null, b: number | string | null, desc = false) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (a < b) return desc ? 1 : -1;
    if (a > b) return desc ? -1 : 1;
    return 0;
  };
  // "What's next" ranks are relatively expensive to derive; precompute once.
  const nextRank = new Map<number, number>();
  if (sort === "next") {
    const now = new Date();
    for (const c of summaries) nextRank.set(c.id, nextActionForCompany(c, now).rank);
  }
  summaries.sort((a, b) => {
    switch (sort) {
      case "next":
        return (
          (nextRank.get(b.id) ?? 0) - (nextRank.get(a.id) ?? 0) ||
          cmpNullsLast(a.target?.next_app_date ?? null, b.target?.next_app_date ?? null) ||
          a.name.localeCompare(b.name)
        );
      case "priority":
        return (
          cmpNullsLast(a.target?.priority_score ?? null, b.target?.priority_score ?? null, true) ||
          a.name.localeCompare(b.name)
        );
      case "next_app_date":
        return (
          cmpNullsLast(a.target?.next_app_date ?? null, b.target?.next_app_date ?? null) ||
          a.name.localeCompare(b.name)
        );
      case "traction": {
        const ra = a.traction ? stageRank(a.traction) : -1;
        const rb = b.traction ? stageRank(b.traction) : -1;
        return rb - ra || a.name.localeCompare(b.name);
      }
      default:
        return a.name.localeCompare(b.name);
    }
  });
  return summaries;
}

// ── Company detail ─────────────────────────────────────────────────────

const personaRank = (p: string | null) => {
  const order = ["recruiter", "product_leader", "alum_product", "product_peer", "alum_other"];
  const i = p ? order.indexOf(p) : -1;
  return i === -1 ? order.length : i;
};

/** Contacts-list order: BYU alumni always lead, then persona rank, then name. */
export const byAlumThenPersona = (
  a: Pick<CompanyPerson, "is_alum" | "persona" | "name">,
  b: Pick<CompanyPerson, "is_alum" | "persona" | "name">,
) =>
  Number(b.is_alum) - Number(a.is_alum) ||
  personaRank(a.persona) - personaRank(b.persona) ||
  a.name.localeCompare(b.name);

export interface CompanyPerson {
  contact_id: number;
  name: string;
  photo_url: string | null;
  headline: string | null;
  persona: string | null;
  network_status: string;
  is_alum: boolean;
  review_note: string | null;
  selection_reason: string | null;
  last_scraped_at: string | null;
  linkedin_url: string | null;
  stage: OutreachStage | null;
  email: { address: string; source: string; bounced: boolean } | null;
  /** Most recent logged interaction (offline touchpoints live on the contact). */
  last_interaction: { type: string; date: string } | null;
  adjacency_score: number | null;
  /** Employment rows at this company (all current titles, newest first). */
  roles: Array<{
    id: number;
    title: string | null;
    is_current: boolean;
    start_month: string | null;
    end_month: string | null;
    location_id: number | null;
    location_label: string | null;
    location_city: string | null;
    location_state: string | null;
    location_country: string | null;
    workplace_type: string | null;
  }>;
  /**
   * The contact's current employer (their `contact_companies` row where `is_current`),
   * which may be a different company than the one whose page this is — mirrors the
   * contacts-list card. Null when no current company is on file.
   */
  current_position: { title: string | null; company_id: number; company_name: string } | null;
}

export interface LocationFacet {
  key: string; // location id as string, or 'remote' / 'unknown'
  label: string;
  location_id: number | null;
  count: number;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface CompanyOffice {
  id: number;
  location_id: number;
  source: string;
  label: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface CompanyNote {
  id: number;
  note: string;
  created_at: string;
  location_id: number | null;
  location_label: string | null;
}

export interface CompanyDetail {
  company: { id: number; name: string; logo_url: string | null; linkedin_url: string | null; universal_name: string | null };
  target: (TargetInfo & { notes: CompanyNote[] }) | null;
  offices: CompanyOffice[];
  facets: LocationFacet[];
  current: CompanyPerson[];
  former: CompanyPerson[];
  bench: CompanyPerson[];
}

function locationLabel(loc: { city: string | null; state: string | null; country: string } | null): string | null {
  if (!loc) return null;
  if (loc.city) return [loc.city, loc.state].filter(Boolean).join(", ");
  if (loc.state) return [loc.state, loc.country].filter(Boolean).join(", ");
  return loc.country || null;
}

export async function getCompanyDetail(
  userId: string,
  companyId: number,
): Promise<CompanyDetail | null> {
  const [companyRes, officesRes, targetRes] = await Promise.all([
    db()
      .from("companies")
      .select("id, name, logo_url, linkedin_url, universal_name")
      .eq("id", companyId)
      .maybeSingle(),
    db()
      .from("company_locations")
      .select("id, location_id, source, locations(city, state, country)")
      .eq("company_id", companyId),
    db()
      .from("target_companies")
      .select("id, priority_score, tier, program_name, app_window_text, next_app_date, status")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .is("location_id", null)
      .eq("is_targeted", true)
      .maybeSingle(),
  ]);
  if (companyRes.error) throw companyRes.error;
  if (!companyRes.data) return null;

  // Employment rows for this company across the user's contacts
  const { data: empRows, error: empError } = await db()
    .from("contact_companies")
    .select(
      `id, contact_id, title, is_current, start_month, end_month, location_id, workplace_type,
       locations(city, state, country),
       contacts!inner(id, user_id, name, photo_url, headline, persona, network_status, verified_school, review_note, last_scraped_at, stage_override, import_meta, linkedin_url)`,
    )
    .eq("company_id", companyId)
    .eq("contacts.user_id", userId)
    .limit(2000);
  if (empError) throw empError;

  const rows = empRows ?? [];
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];

  // Emails, alum badge, stages, latest logged interaction, current employer
  const [emailRows, schoolRows, interactionRows, currentPositionRows] = await Promise.all([
    chunked(contactIds, async (chunk) => {
      return (
        must(
          await db()
            .from("contact_emails")
            .select("contact_id, email, source, is_primary, bounced_at")
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(contactIds, async (chunk) => {
      return (
        must(
          await db().from("contact_schools").select("contact_id, schools(name)").in("contact_id", chunk),
        ) ?? []
      );
    }),
    chunked(contactIds, async (chunk) => {
      return (
        must(
          await db()
            .from("interactions")
            .select("contact_id, interaction_type, interaction_date")
            .in("contact_id", chunk)
            .order("interaction_date", { ascending: false }),
        ) ?? []
      );
    }),
    chunked(contactIds, async (chunk) => {
      return (
        must(
          await db()
            .from("contact_companies")
            .select("contact_id, title, companies(id, name)")
            .eq("is_current", true)
            .in("contact_id", chunk),
        ) ?? []
      );
    }),
  ]);

  const emailByContact = new Map<number, { address: string; source: string; bounced: boolean }>();
  for (const e of emailRows) {
    if (!e.email) continue;
    const existing = emailByContact.get(e.contact_id);
    if (!existing || e.is_primary) {
      emailByContact.set(e.contact_id, { address: e.email, source: e.source, bounced: e.bounced_at != null });
    }
  }
  const alumContacts = new Set<number>();
  for (const s of schoolRows) {
    if (s.schools?.name && isByuSchoolName(s.schools.name)) alumContacts.add(s.contact_id);
  }

  // Rows arrive newest-first per chunk; keep the first seen per contact.
  const lastInteractionByContact = new Map<number, { type: string; date: string }>();
  for (const i of interactionRows) {
    if (!lastInteractionByContact.has(i.contact_id)) {
      lastInteractionByContact.set(i.contact_id, { type: i.interaction_type, date: i.interaction_date });
    }
  }

  // Current employer per contact (contact_companies.is_current); a contact could
  // theoretically have more than one flagged current — keep the first seen.
  const currentPositionByContact = new Map<number, { title: string | null; company_id: number; company_name: string }>();
  for (const p of currentPositionRows) {
    if (!p.companies || currentPositionByContact.has(p.contact_id)) continue;
    currentPositionByContact.set(p.contact_id, { title: p.title, company_id: p.companies.id, company_name: p.companies.name });
  }

  const nonBench = new Map<number, { id: number; stage_override: string | null }>();
  for (const r of rows) {
    if (r.contacts.network_status !== "bench") {
      nonBench.set(r.contact_id, { id: r.contact_id, stage_override: r.contacts.stage_override });
    }
  }
  const stages = await getContactStages(userId, [...nonBench.values()]);

  // Group rows into people
  const peopleById = new Map<number, CompanyPerson>();
  for (const r of rows) {
    let person = peopleById.get(r.contact_id);
    if (!person) {
      const meta = r.contacts.import_meta;
      const adjacency = meta && typeof meta === "object" && "adjacency_score" in meta ? Number(meta.adjacency_score) : NaN;
      person = {
        contact_id: r.contact_id,
        name: r.contacts.name,
        photo_url: r.contacts.photo_url,
        headline: r.contacts.headline,
        persona: r.contacts.persona,
        network_status: r.contacts.network_status,
        is_alum:
          alumContacts.has(r.contact_id) ||
          (r.contacts.verified_school != null && r.contacts.verified_school !== "none"),
        review_note: r.contacts.review_note,
        selection_reason:
          meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.selection_reason === "string"
            ? meta.selection_reason
            : null,
        last_scraped_at: r.contacts.last_scraped_at,
        linkedin_url: r.contacts.linkedin_url,
        stage: stages.get(r.contact_id)?.stage ?? null,
        email: emailByContact.get(r.contact_id) ?? null,
        last_interaction: lastInteractionByContact.get(r.contact_id) ?? null,
        adjacency_score: Number.isNaN(adjacency) ? null : adjacency,
        roles: [],
        current_position: currentPositionByContact.get(r.contact_id) ?? null,
      };
      peopleById.set(r.contact_id, person);
    }
    person.roles.push({
      id: r.id,
      title: r.title,
      is_current: r.is_current,
      start_month: r.start_month,
      end_month: r.end_month,
      location_id: r.location_id,
      location_label: locationLabel(r.locations),
      location_city: r.locations?.city ?? null,
      location_state: r.locations?.state ?? null,
      location_country: r.locations?.country ?? null,
      workplace_type: r.workplace_type,
    });
  }
  for (const person of peopleById.values()) {
    person.roles.sort((a, b) => Number(b.is_current) - Number(a.is_current) || (b.start_month ?? "").localeCompare(a.start_month ?? ""));
  }

  // Facets over everyone at the company (honest buckets incl. Remote/Unknown)
  const facetCounts = new Map<
    string,
    {
      label: string;
      location_id: number | null;
      city: string | null;
      state: string | null;
      country: string | null;
      contacts: Set<number>;
    }
  >();
  for (const r of rows) {
    let key: string;
    let label: string;
    let locId: number | null = null;
    let city: string | null = null;
    let state: string | null = null;
    let country: string | null = null;
    if (r.workplace_type === "remote") {
      key = "remote";
      label = "Remote";
    } else if (r.location_id != null) {
      key = String(r.location_id);
      label = locationLabel(r.locations) ?? `Location ${r.location_id}`;
      locId = r.location_id;
      city = r.locations?.city ?? null;
      state = r.locations?.state ?? null;
      country = r.locations?.country ?? null;
    } else {
      key = "unknown";
      label = "Unknown";
    }
    let f = facetCounts.get(key);
    if (!f) {
      f = { label, location_id: locId, city, state, country, contacts: new Set() };
      facetCounts.set(key, f);
    }
    f.contacts.add(r.contact_id);
  }
  const facets: LocationFacet[] = [...facetCounts.entries()]
    .map(([key, f]) => ({
      key,
      label: f.label,
      location_id: f.location_id,
      count: f.contacts.size,
      city: f.city,
      state: f.state,
      country: f.country,
    }))
    .sort((a, b) => {
      // Real locations first (by count desc), then Remote, then Unknown
      const special = (k: string) => (k === "unknown" ? 2 : k === "remote" ? 1 : 0);
      return special(a.key) - special(b.key) || b.count - a.count || a.label.localeCompare(b.label);
    });

  const isCurrent = new Set(rows.filter((r) => r.is_current).map((r) => r.contact_id));

  const current: CompanyPerson[] = [];
  const former: CompanyPerson[] = [];
  const bench: CompanyPerson[] = [];
  for (const person of peopleById.values()) {
    if (person.network_status === "bench") {
      bench.push(person);
    } else if (isCurrent.has(person.contact_id)) {
      current.push(person);
    } else {
      former.push(person);
    }
  }
  current.sort(byAlumThenPersona);
  former.sort(byAlumThenPersona);
  // Bench: the pipeline's own ranking (adjacency), best first
  bench.sort((a, b) => (b.adjacency_score ?? -1) - (a.adjacency_score ?? -1) || a.name.localeCompare(b.name));

  // Target notes
  let target: CompanyDetail["target"] = null;
  if (targetRes.data) {
    const t = targetRes.data as TargetInfo;
    const noteRows = must(
      await db()
        .from("target_company_notes")
        .select("id, note, created_at, location_id, locations(city, state, country)")
        .eq("target_company_id", t.id)
        .order("created_at", { ascending: false }),
    );
    const notes: CompanyNote[] = ((noteRows) ?? [])
      .map((n) => ({
        id: n.id,
        note: n.note,
        created_at: n.created_at,
        location_id: n.location_id,
        location_label: locationLabel(n.locations),
      }));
    target = { ...t, notes };
  }

  const offices: CompanyOffice[] = ((officesRes.data) ?? []).map((o) => ({
    id: o.id,
    location_id: o.location_id,
    source: o.source,
    label: locationLabel(o.locations) ?? `Location ${o.location_id}`,
    city: o.locations?.city ?? null,
    state: o.locations?.state ?? null,
    country: o.locations?.country ?? null,
  }));

  return {
    company: companyRes.data as CompanyDetail["company"],
    target,
    offices,
    facets,
    current,
    former,
    bench,
  };
}

// ── Mutations ──────────────────────────────────────────────────────────

/** Bench → prospect ("Add to outreach"). */
export async function promoteContactToProspect(contactId: number) {
  const { error } = await db().from("contacts").update({ network_status: "prospect" }).eq("id", contactId);
  if (error) throw error;
}

/** Prospect → bench (demote). */
export async function demoteContactToBench(contactId: number) {
  const { error } = await db().from("contacts").update({ network_status: "bench" }).eq("id", contactId);
  if (error) throw error;
}

/**
 * Delete an office with the plan-24 cascade: dependent profile_match
 * employment locations are nulled (they were inferred FROM this office);
 * experience-sourced rows keep their location (first-person evidence)
 * but no longer imply an office.
 */
export async function deleteCompanyOffice(office: { id: number; location_id: number }, companyId: number) {
  const { error: clearError } = await db()
    .from("contact_companies")
    .update({ location_id: null, location_source: null })
    .eq("company_id", companyId)
    .eq("location_id", office.location_id)
    .eq("location_source", "profile_match");
  if (clearError) throw clearError;
  const { error } = await db().from("company_locations").delete().eq("id", office.id);
  if (error) throw error;

  // Deleting the office removes it from the scope dropdown; soft-untarget
  // the (RLS-scoped, own) target row for it so a targeted-but-invisible
  // ghost can't linger on the targets list. Pipeline data is kept and
  // resurfaces if the office is re-added.
  const { error: untargetError } = await db()
    .from("target_companies")
    .update({ is_targeted: false, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("location_id", office.location_id)
    .eq("is_targeted", true);
  if (untargetError) throw untargetError;
}

export async function addCompanyOffice(companyId: number, locationId: number) {
  const { error } = await db()
    .from("company_locations")
    .upsert({ company_id: companyId, location_id: locationId, source: "manual" }, { onConflict: "company_id,location_id", ignoreDuplicates: true });
  if (error) throw error;
}

export interface CompanyOfficeLocationInput {
  city: string | null;
  state: string | null;
  country: string;
}

export function normalizeCompanyOfficeLocationInput(input: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): CompanyOfficeLocationInput {
  return {
    city: input.city?.trim() || null,
    state: input.state?.trim() || null,
    country: input.country?.trim() || "United States",
  };
}

export function formatCompanyOfficeLocationLabel(location: CompanyOfficeLocationInput): string {
  if (location.city) return [location.city, location.state].filter(Boolean).join(", ");
  if (location.state) return [location.state, location.country].filter(Boolean).join(", ");
  return location.country;
}

export async function addCompanyOfficeLocation(
  companyId: number,
  input: { city?: string | null; state?: string | null; country?: string | null },
): Promise<{ locationId: number; added: boolean; label: string }> {
  const normalized = normalizeCompanyOfficeLocationInput(input);
  const location = await findOrCreateOfficeLocation(normalized);
  const label = formatCompanyOfficeLocationLabel(normalized);

  const existing = must(
    await db()
      .from("company_locations")
      .select("id")
      .eq("company_id", companyId)
      .eq("location_id", location.id)
      .maybeSingle(),
  );
  if (existing) {
    return { locationId: location.id, added: false, label };
  }

  await addCompanyOffice(companyId, location.id);
  return { locationId: location.id, added: true, label };
}

async function findOrCreateOfficeLocation(location: CompanyOfficeLocationInput): Promise<{ id: number }> {
  function buildLookup() {
    let q = db().from("locations").select("id");
    q = location.city ? q.eq("city", location.city) : q.is("city", null);
    q = location.state ? q.eq("state", location.state) : q.is("state", null);
    return q.eq("country", location.country);
  }

  const existing = must(await buildLookup().maybeSingle());
  if (existing) return existing as { id: number };

  const { data, error } = await db()
    .from("locations")
    .insert({
      city: location.city,
      state: location.state,
      country: location.country,
    })
    .select("id")
    .single();
  if (error) {
    // error-tolerated: this lookup only exists to recover from a concurrent
    // insert winning the unique constraint; if it fails too we fall through
    // and throw the original insert error, which is the more useful one.
    const { data: retry } = await buildLookup().maybeSingle();
    if (retry) return retry as { id: number };
    throw error;
  }
  return data as { id: number };
}

export interface ManualCompanyInput {
  name: string;
  linkedin_url: string | null;
  location: CompanyOfficeLocationInput | null;
}

/**
 * Normalize the add-company modal's raw fields. Returns null when no
 * usable name was given. A location counts as provided only when city or
 * state is filled — the country field is prefilled ("United States"), so
 * country alone doesn't imply the user meant to record an office.
 */
export function normalizeManualCompanyInput(input: {
  name?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): ManualCompanyInput | null {
  const name = input.name?.trim();
  if (!name) return null;
  const hasLocation = Boolean(input.city?.trim() || input.state?.trim());
  return {
    name,
    linkedin_url: input.linkedin_url?.trim() || null,
    location: hasLocation ? normalizeCompanyOfficeLocationInput(input) : null,
  };
}

/**
 * "Add company" from the companies page (CAR-34): find-or-create through
 * the shared identity path (never mints a duplicate row), ensure it's one
 * of the user's targets so it appears in the default view, and record an
 * office when a location was given.
 */
export async function addCompanyManually(
  userId: string,
  input: { name?: string | null; linkedin_url?: string | null; city?: string | null; state?: string | null; country?: string | null },
): Promise<{ companyId: number; companyName: string; alreadyTargeted: boolean }> {
  const normalized = normalizeManualCompanyInput(input);
  if (!normalized) throw new Error("Company name is required");

  const company = await findOrCreateCompany(db(), {
    name: normalized.name,
    linkedin_url: normalized.linkedin_url,
  });

  const { data: existingTarget, error: targetLookupError } = await db()
    .from("target_companies")
    .select("id, is_targeted")
    .eq("user_id", userId)
    .eq("company_id", company.id)
    .is("location_id", null)
    .maybeSingle();
  if (targetLookupError) throw targetLookupError;
  if (!existingTarget) await addTargetCompany(userId, company.id);
  else if (!(existingTarget as { is_targeted: boolean }).is_targeted) {
    await updateTargetCompanyTargeted((existingTarget as { id: number }).id, true);
  }

  if (normalized.location) {
    await addCompanyOfficeLocation(company.id, normalized.location);
  }

  return { companyId: company.id, companyName: company.name, alreadyTargeted: Boolean(existingTarget) };
}

export async function addTargetCompany(userId: string, companyId: number) {
  // A soft-untargeted company-wide row may already exist (CAR-6 keeps
  // pipeline data on un-target) — revive it instead of violating the
  // partial unique index.
  const { data: existing, error: lookupError } = await db()
    .from("target_companies")
    .select("id, is_targeted")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .is("location_id", null)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const row = existing as { id: number; is_targeted: boolean };
    if (!row.is_targeted) await updateTargetCompanyTargeted(row.id, true);
    return { id: row.id };
  }

  const { data, error } = await db()
    .from("target_companies")
    .insert({ user_id: userId, company_id: companyId })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: number };
}

export async function updateTargetCompanyTargeted(targetId: number, isTargeted: boolean) {
  const { error } = await db()
    .from("target_companies")
    .update({ is_targeted: isTargeted, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

/** Remove a company from the user's targets (notes cascade-delete). */
export async function removeTargetCompany(targetId: number) {
  const { error } = await db().from("target_companies").delete().eq("id", targetId);
  if (error) throw error;
}

export async function updateTargetCompany(
  targetId: number,
  patch: Partial<Pick<TargetInfo, "priority_score" | "tier" | "program_name" | "app_window_text" | "next_app_date" | "status">>,
) {
  const { error } = await db()
    .from("target_companies")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

export async function addTargetCompanyNote(targetCompanyId: number, note: string, locationId?: number | null) {
  const { error } = await db()
    .from("target_company_notes")
    .insert({ target_company_id: targetCompanyId, note, location_id: locationId ?? null });
  if (error) throw error;
}

export async function deleteTargetCompanyNote(noteId: number) {
  const { error } = await db().from("target_company_notes").delete().eq("id", noteId);
  if (error) throw error;
}

/** Manual stage override ("mark as contacted" etc.); null clears it. */
export async function setStageOverride(contactId: number, stage: string | null) {
  const { error } = await db().from("contacts").update({ stage_override: stage }).eq("id", contactId);
  if (error) throw error;
}
