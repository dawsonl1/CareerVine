/**
 * Dossier assembly — turns the raw DossierBundle rows into the single
 * structured document get_contact_dossier returns. This is the grounding
 * payload for writing an informed email, so it favors completeness and
 * provenance flags (email source/bounced, alum, tier, derived stage)
 * over brevity. Pure formatting: no I/O.
 */

import type { DossierBundle } from "./db";
import { dateKeyOf, daysBetweenDateKeys } from "@/lib/calendar-day";
import { abbrFor, schoolsMatch } from "@/lib/schools/affinity";

interface ContactEmbed {
  id: number;
  name: string;
  headline: string | null;
  industry: string | null;
  persona: string | null;
  linkedin_url: string | null;
  notes: string | null;
  met_through: string | null;
  network_status: string;
  stage_override: string | null;
  review_note: string | null;
  follow_up_frequency_days: number | null;
  contact_status: string | null;
  expected_graduation: string | null;
  created_at: string;
  locations: { city: string | null; state: string | null; country: string } | null;
  contact_emails: Array<{ email: string | null; is_primary: boolean; source: string; bounced_at: string | null }>;
  contact_phones: Array<{ phone: string; type: string; is_primary: boolean }>;
  contact_companies: Array<{
    title: string | null;
    is_current: boolean;
    start_month: string | null;
    end_month: string | null;
    workplace_type: string | null;
    companies: { id: number; name: string } | null;
  }>;
  contact_schools: Array<{
    degree: string | null;
    field_of_study: string | null;
    start_year: number | null;
    end_year: number | null;
    schools: { name: string } | null;
  }>;
  contact_tags: Array<{ tags: { name: string } | null }>;
}

export interface Dossier {
  summary: string;
  identity: Record<string, unknown>;
  status: Record<string, unknown>;
  work_history: Array<Record<string, unknown>>;
  education: Array<Record<string, unknown>>;
  emails: Array<Record<string, unknown>>;
  phones: Array<Record<string, unknown>>;
  tags: string[];
  notes: string | null;
  open_action_items: Array<Record<string, unknown>>;
  recent_completed_action_items: Array<Record<string, unknown>>;
  interactions: { total: number; shown: Array<Record<string, unknown>> };
  meetings: { total: number; shown: Array<Record<string, unknown>> };
  email_history: { total: number; shown: Array<Record<string, unknown>> };
  pending_sends: Record<string, unknown>;
}

export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  // Whole CALENDAR days, not elapsed milliseconds (CAR-206). Dividing a raw gap
  // makes "1 day ago" mean "somewhere between 24 and 48 hours", so a touch
  // yesterday evening reads as 0 days ago until this time tomorrow.
  return daysBetweenDateKeys(dateKeyOf(then), dateKeyOf(now));
}

export function buildDossier(
  bundle: DossierBundle,
  stage: string | null,
  now: Date = new Date(),
  /** The ACCOUNT HOLDER's school. Null (the default) means no school claimed,
   * so nothing is an alum and no alum line appears (CAR-213). */
  viewerSchool: string | null = null,
): Dossier {
  const viewerSchoolAbbr = abbrFor(viewerSchool);
  const c = bundle.contact as unknown as ContactEmbed;

  const currentRole = c.contact_companies.find((cc) => cc.is_current);
  const roleLine = currentRole
    ? [currentRole.title, currentRole.companies?.name].filter(Boolean).join(" at ")
    : null;

  const lastTouchDates = [
    ...bundle.interactions.map((i) => String(i.interaction_date ?? "")),
    ...bundle.meetings.map((m) => String(m.meeting_date ?? "")),
  ].filter(Boolean);
  const lastTouch = lastTouchDates.length > 0 ? lastTouchDates.sort().at(-1)! : null;
  const lastTouchDays = daysSince(lastTouch, now);

  // Viewer-scoped (CAR-213): "alum" means an alum of the ACCOUNT HOLDER's
  // school, so this is false for a user who has claimed no school. Passing
  // viewerSchool is what stops an MCP client being told a stranger is an alum.
  const isAlum = c.contact_schools.some((s) => schoolsMatch(s.schools?.name, viewerSchool));

  const location = c.locations
    ? [c.locations.city, c.locations.state, c.locations.country].filter(Boolean).join(", ")
    : null;

  const tierLabel =
    c.network_status === "active" ? "in my network" : c.network_status === "prospect" ? "prospect" : "archived";

  const summaryParts = [
    `${c.name}${roleLine ? `, ${roleLine}` : ""} (${tierLabel}${stage ? `, stage: ${stage}` : ""}).`,
    lastTouchDays != null ? `Last touch ${lastTouchDays} day${lastTouchDays === 1 ? "" : "s"} ago.` : "Never contacted.",
    isAlum ? `${viewerSchoolAbbr ?? "School"} alum.` : null,
    bundle.openActionItems.length > 0 ? `${bundle.openActionItems.length} open action item(s).` : null,
  ].filter(Boolean);

  return {
    summary: summaryParts.join(" "),
    identity: {
      contact_id: c.id,
      name: c.name,
      headline: c.headline,
      persona: c.persona,
      industry: c.industry,
      location,
      linkedin_url: c.linkedin_url,
      met_through: c.met_through,
      contact_status: c.contact_status,
      expected_graduation: c.expected_graduation,
      // RENAMED from is_byu_alum (CAR-213): the old name asserts a specific
      // school, and the value now means "went to the ACCOUNT HOLDER's school",
      // whatever that is.
      //
      // Safe to rename despite being tool output. get_contact_dossier
      // registers an inputSchema only — there is no outputSchema — so this
      // shape is unpinned free-form JSON read by an LLM, which absorbs a field
      // rename rather than throwing on it. careervine-mcp is a thin stdio
      // wrapper importing this repo's own register-tools, not an independent
      // client, so it cannot drift. An earlier version of this comment called
      // it a breaking external contract change; that was wrong.
      is_school_alum: isAlum,
      added_at: c.created_at,
    },
    status: {
      network_tier: c.network_status,
      outreach_stage: stage,
      stage_override: c.stage_override,
      follow_up_cadence_days: c.follow_up_frequency_days,
      last_touch: lastTouch,
      last_touch_days_ago: lastTouchDays,
      pipeline_review_note: c.review_note,
    },
    work_history: c.contact_companies
      .slice()
      .sort((a, b) => Number(b.is_current) - Number(a.is_current) || (b.start_month ?? "").localeCompare(a.start_month ?? ""))
      .map((cc) => ({
        company: cc.companies?.name ?? null,
        company_id: cc.companies?.id ?? null,
        title: cc.title,
        is_current: cc.is_current,
        start_month: cc.start_month,
        end_month: cc.end_month,
        workplace_type: cc.workplace_type,
      })),
    education: c.contact_schools.map((s) => ({
      school: s.schools?.name ?? null,
      degree: s.degree,
      field_of_study: s.field_of_study,
      start_year: s.start_year,
      end_year: s.end_year,
    })),
    emails: c.contact_emails
      .filter((e) => e.email)
      .map((e) => ({
        email: e.email,
        is_primary: e.is_primary,
        source: e.source,
        bounced: e.bounced_at != null,
      })),
    phones: c.contact_phones.map((p) => ({ phone: p.phone, type: p.type, is_primary: p.is_primary })),
    tags: c.contact_tags.map((t) => t.tags?.name).filter(Boolean) as string[],
    notes: c.notes,
    open_action_items: bundle.openActionItems,
    recent_completed_action_items: bundle.completedActionItems,
    interactions: { total: bundle.interactionsTotal, shown: bundle.interactions },
    meetings: { total: bundle.meetingsTotal, shown: bundle.meetings },
    email_history: { total: bundle.emailsTotal, shown: bundle.emails },
    pending_sends: {
      scheduled_emails: bundle.scheduledEmails,
      active_follow_up_sequences: bundle.activeFollowUps,
    },
  };
}
