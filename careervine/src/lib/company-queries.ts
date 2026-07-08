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

const supabase = createSupabaseBrowserClient();

// ── Shared helpers ─────────────────────────────────────────────────────

/** Chunk .in() filters — PostgREST URLs blow up past a few hundred ids. */
async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...(await fn(ids.slice(i, i + 200))));
  }
  return out;
}

/** Schools that light the alum badge (extend as review shows gaps). */
export function isByuSchoolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.includes("brigham young") || n.startsWith("byu");
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

  const [emails, interactions, referrals, bounces, calEvents, calLinks, meetingLinks] = await Promise.all([
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("email_messages")
        .select("matched_contact_id, direction, date")
        .eq("user_id", userId)
        .eq("is_simulated", false)
        .in("matched_contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase.from("interactions").select("contact_id").in("contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("referrals")
        .select("referred_by_contact_id")
        .eq("user_id", userId)
        .in("referred_by_contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("contact_emails")
        .select("contact_id")
        .not("bounced_at", "is", null)
        .in("contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("calendar_events")
        .select("contact_id, start_at, status")
        .eq("user_id", userId)
        .in("contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("calendar_event_contacts")
        .select("contact_id, calendar_events!inner(user_id, start_at, status)")
        .eq("calendar_events.user_id", userId)
        .in("contact_id", chunk);
      return data ?? [];
    }),
    chunked(ids, async (chunk) => {
      const { data } = await supabase
        .from("meeting_contacts")
        .select("contact_id, meetings!inner(user_id, meeting_date)")
        .eq("meetings.user_id", userId)
        .in("contact_id", chunk);
      return data ?? [];
    }),
  ]);

  // Aggregate signals per contact
  const outboundAt = new Map<number, string>(); // earliest outbound date
  const inboundAt = new Map<number, string[]>();
  for (const m of emails as Array<{ matched_contact_id: number | null; direction: string | null; date: string | null }>) {
    if (m.matched_contact_id == null) continue;
    if (m.direction === "outbound") {
      const prev = outboundAt.get(m.matched_contact_id);
      const d = m.date ?? "";
      if (!prev || d < prev) outboundAt.set(m.matched_contact_id, d);
    } else if (m.direction === "inbound") {
      const list = inboundAt.get(m.matched_contact_id) ?? [];
      list.push(m.date ?? "");
      inboundAt.set(m.matched_contact_id, list);
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
  for (const e of calEvents as Array<{ contact_id: number | null; start_at: string | null; status: string | null }>) {
    noteEvent(e.contact_id, e.start_at, e.status);
  }
  for (const l of calLinks as unknown as Array<{ contact_id: number; calendar_events: { start_at: string | null; status: string | null } }>) {
    noteEvent(l.contact_id, l.calendar_events?.start_at ?? null, l.calendar_events?.status ?? null);
  }
  for (const l of meetingLinks as unknown as Array<{ contact_id: number; meetings: { meeting_date: string | null } }>) {
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

export interface CompanySummary {
  id: number;
  name: string;
  logo_url: string | null;
  linkedin_url: string | null;
  domain: string | null;
  current_count: number;
  former_count: number;
  bench_count: number;
  target: TargetInfo | null;
  /** Max derived stage across non-bench contacts (targets view only). */
  traction: OutreachStage | null;
}

export type CompanySort = "priority" | "traction" | "next_app_date" | "name";

interface EmploymentAggRow {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  contacts: { network_status: string; stage_override: string | null };
}

async function fetchUserEmploymentRows(userId: string): Promise<EmploymentAggRow[]> {
  const PAGE = 1000;
  const all: EmploymentAggRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("contact_companies")
      .select("company_id, contact_id, is_current, contacts!inner(user_id, network_status, stage_override)")
      .eq("contacts.user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as unknown as EmploymentAggRow[] | null) ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

export async function getCompanies(
  userId: string,
  opts: { targetsOnly?: boolean; search?: string; minContacts?: number; sort?: CompanySort } = {},
): Promise<CompanySummary[]> {
  const targetsOnly = opts.targetsOnly ?? true;
  const sort = opts.sort ?? (targetsOnly ? "priority" : "name");

  const [employment, targetsRes] = await Promise.all([
    fetchUserEmploymentRows(userId),
    supabase
      .from("target_companies")
      .select("id, company_id, priority_score, tier, program_name, app_window_text, next_app_date, status")
      .eq("user_id", userId),
  ]);
  if (targetsRes.error) throw targetsRes.error;
  const targets = (targetsRes.data ?? []) as Array<TargetInfo & { company_id: number }>;
  const targetByCompany = new Map(targets.map((t) => [t.company_id, t]));

  // Aggregate people per company; bench counted separately, never mixed
  interface Agg {
    current: Set<number>;
    former: Set<number>;
    bench: Set<number>;
    contactRows: Array<{ id: number; stage_override: string | null }>;
  }
  const aggByCompany = new Map<number, Agg>();
  for (const row of employment) {
    let agg = aggByCompany.get(row.company_id);
    if (!agg) {
      agg = { current: new Set(), former: new Set(), bench: new Set(), contactRows: [] };
      aggByCompany.set(row.company_id, agg);
    }
    if (row.contacts.network_status === "bench") {
      agg.bench.add(row.contact_id);
    } else {
      (row.is_current ? agg.current : agg.former).add(row.contact_id);
      agg.contactRows.push({ id: row.contact_id, stage_override: row.contacts.stage_override });
    }
  }
  // A boomeranger is current, not former
  for (const agg of aggByCompany.values()) {
    for (const id of agg.current) agg.former.delete(id);
  }

  // Which companies to show
  let companyIds: number[];
  if (targetsOnly) {
    companyIds = targets.map((t) => t.company_id);
  } else {
    const minContacts = opts.minContacts ?? 1;
    companyIds = [...aggByCompany.entries()]
      .filter(([, agg]) => agg.current.size + agg.former.size >= minContacts)
      .map(([id]) => id);
    for (const t of targets) if (!companyIds.includes(t.company_id)) companyIds.push(t.company_id);
  }
  if (companyIds.length === 0) return [];

  // Company rows (chunked)
  const companyRows = await chunked(companyIds, async (chunk) => {
    let q = supabase
      .from("companies")
      .select("id, name, logo_url, linkedin_url, domain")
      .in("id", chunk);
    if (opts.search?.trim()) {
      q = q.ilike("name", `%${opts.search.trim().replace(/([\\%_])/g, "\\$1")}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  });

  // Traction: max derived stage per company — targets view only (bounded)
  const traction = new Map<number, OutreachStage>();
  if (targetsOnly) {
    const uniqueContacts = new Map<number, { id: number; stage_override: string | null }>();
    for (const id of companyIds) {
      for (const c of aggByCompany.get(id)?.contactRows ?? []) uniqueContacts.set(c.id, c);
    }
    const stages = await getContactStages(userId, [...uniqueContacts.values()]);
    for (const id of companyIds) {
      let best: ContactStage | null = null;
      const seen = new Set<number>();
      for (const c of aggByCompany.get(id)?.contactRows ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const s = stages.get(c.id);
        if (s && (!best || s.rank > best.rank)) best = s;
      }
      if (best) traction.set(id, best.stage);
    }
  }

  const summaries: CompanySummary[] = (companyRows as Array<{
    id: number;
    name: string;
    logo_url: string | null;
    linkedin_url: string | null;
    domain: string | null;
  }>).map((c) => {
    const agg = aggByCompany.get(c.id);
    const target = targetByCompany.get(c.id);
    return {
      id: c.id,
      name: c.name,
      logo_url: c.logo_url,
      linkedin_url: c.linkedin_url,
      domain: c.domain,
      current_count: agg?.current.size ?? 0,
      former_count: agg?.former.size ?? 0,
      bench_count: agg?.bench.size ?? 0,
      target: target
        ? {
            id: target.id,
            priority_score: target.priority_score,
            tier: target.tier,
            program_name: target.program_name,
            app_window_text: target.app_window_text,
            next_app_date: target.next_app_date,
            status: target.status,
          }
        : null,
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
  summaries.sort((a, b) => {
    switch (sort) {
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
  stage: OutreachStage | null;
  email: { address: string; source: string; bounced: boolean } | null;
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
    workplace_type: string | null;
  }>;
}

export interface LocationFacet {
  key: string; // location id as string, or 'remote' / 'unknown'
  label: string;
  location_id: number | null;
  count: number;
}

export interface CompanyOffice {
  id: number;
  location_id: number;
  source: string;
  label: string;
}

export interface CompanyNote {
  id: number;
  note: string;
  created_at: string;
  location_id: number | null;
  location_label: string | null;
}

export interface CompanyDetail {
  company: { id: number; name: string; logo_url: string | null; linkedin_url: string | null; domain: string | null; universal_name: string | null };
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
  opts: { locationKey?: string } = {},
): Promise<CompanyDetail | null> {
  const [companyRes, officesRes, targetRes] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, logo_url, linkedin_url, domain, universal_name")
      .eq("id", companyId)
      .maybeSingle(),
    supabase
      .from("company_locations")
      .select("id, location_id, source, locations(city, state, country)")
      .eq("company_id", companyId),
    supabase
      .from("target_companies")
      .select("id, priority_score, tier, program_name, app_window_text, next_app_date, status")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .maybeSingle(),
  ]);
  if (companyRes.error) throw companyRes.error;
  if (!companyRes.data) return null;

  // Employment rows for this company across the user's contacts
  const { data: empRows, error: empError } = await supabase
    .from("contact_companies")
    .select(
      `id, contact_id, title, is_current, start_month, end_month, location_id, workplace_type,
       locations(city, state, country),
       contacts!inner(id, user_id, name, photo_url, headline, persona, network_status, verified_school, review_note, last_scraped_at, stage_override, import_meta)`,
    )
    .eq("company_id", companyId)
    .eq("contacts.user_id", userId)
    .limit(2000);
  if (empError) throw empError;

  type EmpRow = {
    id: number;
    contact_id: number;
    title: string | null;
    is_current: boolean;
    start_month: string | null;
    end_month: string | null;
    location_id: number | null;
    workplace_type: string | null;
    locations: { city: string | null; state: string | null; country: string } | null;
    contacts: {
      id: number;
      name: string;
      photo_url: string | null;
      headline: string | null;
      persona: string | null;
      network_status: string;
      verified_school: string | null;
      review_note: string | null;
      last_scraped_at: string | null;
      stage_override: string | null;
      import_meta: Record<string, unknown> | null;
    };
  };
  const rows = ((empRows as unknown as EmpRow[] | null) ?? []);
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];

  // Emails, alum badge, stages
  const [emailRows, schoolRows] = await Promise.all([
    chunked(contactIds, async (chunk) => {
      const { data } = await supabase
        .from("contact_emails")
        .select("contact_id, email, source, is_primary, bounced_at")
        .in("contact_id", chunk);
      return data ?? [];
    }),
    chunked(contactIds, async (chunk) => {
      const { data } = await supabase
        .from("contact_schools")
        .select("contact_id, schools(name)")
        .in("contact_id", chunk);
      return data ?? [];
    }),
  ]);

  const emailByContact = new Map<number, { address: string; source: string; bounced: boolean }>();
  for (const e of emailRows as Array<{ contact_id: number; email: string | null; source: string; is_primary: boolean; bounced_at: string | null }>) {
    if (!e.email) continue;
    const existing = emailByContact.get(e.contact_id);
    if (!existing || e.is_primary) {
      emailByContact.set(e.contact_id, { address: e.email, source: e.source, bounced: e.bounced_at != null });
    }
  }
  const alumContacts = new Set<number>();
  for (const s of schoolRows as unknown as Array<{ contact_id: number; schools: { name: string } | null }>) {
    if (s.schools?.name && isByuSchoolName(s.schools.name)) alumContacts.add(s.contact_id);
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
          meta && typeof meta === "object" && typeof meta.selection_reason === "string"
            ? meta.selection_reason
            : null,
        last_scraped_at: r.contacts.last_scraped_at,
        stage: stages.get(r.contact_id)?.stage ?? null,
        email: emailByContact.get(r.contact_id) ?? null,
        adjacency_score: Number.isNaN(adjacency) ? null : adjacency,
        roles: [],
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
      workplace_type: r.workplace_type,
    });
  }
  for (const person of peopleById.values()) {
    person.roles.sort((a, b) => Number(b.is_current) - Number(a.is_current) || (b.start_month ?? "").localeCompare(a.start_month ?? ""));
  }

  // Facets over everyone at the company (honest buckets incl. Remote/Unknown)
  const facetCounts = new Map<string, { label: string; location_id: number | null; contacts: Set<number> }>();
  for (const r of rows) {
    let key: string;
    let label: string;
    let locId: number | null = null;
    if (r.workplace_type === "remote") {
      key = "remote";
      label = "Remote";
    } else if (r.location_id != null) {
      key = String(r.location_id);
      label = locationLabel(r.locations) ?? `Location ${r.location_id}`;
      locId = r.location_id;
    } else {
      key = "unknown";
      label = "Unknown";
    }
    let f = facetCounts.get(key);
    if (!f) {
      f = { label, location_id: locId, contacts: new Set() };
      facetCounts.set(key, f);
    }
    f.contacts.add(r.contact_id);
  }
  const facets: LocationFacet[] = [...facetCounts.entries()]
    .map(([key, f]) => ({ key, label: f.label, location_id: f.location_id, count: f.contacts.size }))
    .sort((a, b) => {
      // Real locations first (by count desc), then Remote, then Unknown
      const special = (k: string) => (k === "unknown" ? 2 : k === "remote" ? 1 : 0);
      return special(a.key) - special(b.key) || b.count - a.count || a.label.localeCompare(b.label);
    });

  // Location scoping
  let scopedIds: Set<number> | null = null;
  if (opts.locationKey) {
    scopedIds = new Set<number>();
    for (const r of rows) {
      const matches =
        opts.locationKey === "remote"
          ? r.workplace_type === "remote"
          : opts.locationKey === "unknown"
            ? r.workplace_type !== "remote" && r.location_id == null
            : String(r.location_id) === opts.locationKey;
      if (matches) scopedIds.add(r.contact_id);
    }
  }

  const isCurrent = new Set(rows.filter((r) => r.is_current).map((r) => r.contact_id));
  const inScope = (id: number) => !scopedIds || scopedIds.has(id);

  const personaRank = (p: string | null) => {
    const order = ["recruiter", "product_leader", "alum_product", "product_peer", "alum_other"];
    const i = p ? order.indexOf(p) : -1;
    return i === -1 ? order.length : i;
  };

  const current: CompanyPerson[] = [];
  const former: CompanyPerson[] = [];
  const bench: CompanyPerson[] = [];
  for (const person of peopleById.values()) {
    if (!inScope(person.contact_id)) continue;
    if (person.network_status === "bench") {
      bench.push(person);
    } else if (isCurrent.has(person.contact_id)) {
      current.push(person);
    } else {
      former.push(person);
    }
  }
  const byPersona = (a: CompanyPerson, b: CompanyPerson) =>
    personaRank(a.persona) - personaRank(b.persona) || a.name.localeCompare(b.name);
  current.sort(byPersona);
  former.sort(byPersona);
  // Bench: the pipeline's own ranking (adjacency), best first
  bench.sort((a, b) => (b.adjacency_score ?? -1) - (a.adjacency_score ?? -1) || a.name.localeCompare(b.name));

  // Target notes
  let target: CompanyDetail["target"] = null;
  if (targetRes.data) {
    const t = targetRes.data as TargetInfo;
    const { data: noteRows } = await supabase
      .from("target_company_notes")
      .select("id, note, created_at, location_id, locations(city, state, country)")
      .eq("target_company_id", t.id)
      .order("created_at", { ascending: false });
    const notes: CompanyNote[] = ((noteRows as unknown as Array<{
      id: number;
      note: string;
      created_at: string;
      location_id: number | null;
      locations: { city: string | null; state: string | null; country: string } | null;
    }> | null) ?? [])
      .filter((n) => !opts.locationKey || opts.locationKey === "remote" || opts.locationKey === "unknown" || n.location_id == null || String(n.location_id) === opts.locationKey)
      .map((n) => ({
        id: n.id,
        note: n.note,
        created_at: n.created_at,
        location_id: n.location_id,
        location_label: locationLabel(n.locations),
      }));
    target = { ...t, notes };
  }

  const offices: CompanyOffice[] = ((officesRes.data as unknown as Array<{
    id: number;
    location_id: number;
    source: string;
    locations: { city: string | null; state: string | null; country: string } | null;
  }> | null) ?? []).map((o) => ({
    id: o.id,
    location_id: o.location_id,
    source: o.source,
    label: locationLabel(o.locations) ?? `Location ${o.location_id}`,
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
  const { error } = await supabase.from("contacts").update({ network_status: "prospect" }).eq("id", contactId);
  if (error) throw error;
}

/** Prospect → bench (demote). */
export async function demoteContactToBench(contactId: number) {
  const { error } = await supabase.from("contacts").update({ network_status: "bench" }).eq("id", contactId);
  if (error) throw error;
}

/**
 * Delete an office with the plan-24 cascade: dependent profile_match
 * employment locations are nulled (they were inferred FROM this office);
 * experience-sourced rows keep their location (first-person evidence)
 * but no longer imply an office.
 */
export async function deleteCompanyOffice(office: { id: number; location_id: number }, companyId: number) {
  const { error: clearError } = await supabase
    .from("contact_companies")
    .update({ location_id: null, location_source: null })
    .eq("company_id", companyId)
    .eq("location_id", office.location_id)
    .eq("location_source", "profile_match");
  if (clearError) throw clearError;
  const { error } = await supabase.from("company_locations").delete().eq("id", office.id);
  if (error) throw error;
}

export async function addCompanyOffice(companyId: number, locationId: number) {
  const { error } = await supabase
    .from("company_locations")
    .upsert({ company_id: companyId, location_id: locationId, source: "manual" }, { onConflict: "company_id,location_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function addTargetCompany(userId: string, companyId: number) {
  const { data, error } = await supabase
    .from("target_companies")
    .insert({ user_id: userId, company_id: companyId })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: number };
}

export async function updateTargetCompany(
  targetId: number,
  patch: Partial<Pick<TargetInfo, "priority_score" | "tier" | "program_name" | "app_window_text" | "next_app_date" | "status">>,
) {
  const { error } = await supabase
    .from("target_companies")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

export async function addTargetCompanyNote(targetCompanyId: number, note: string, locationId?: number | null) {
  const { error } = await supabase
    .from("target_company_notes")
    .insert({ target_company_id: targetCompanyId, note, location_id: locationId ?? null });
  if (error) throw error;
}

export async function deleteTargetCompanyNote(noteId: number) {
  const { error } = await supabase.from("target_company_notes").delete().eq("id", noteId);
  if (error) throw error;
}

/** Manual stage override ("mark as contacted" etc.); null clears it. */
export async function setStageOverride(contactId: number, stage: string | null) {
  const { error } = await supabase.from("contacts").update({ stage_override: stage }).eq("id", contactId);
  if (error) throw error;
}
