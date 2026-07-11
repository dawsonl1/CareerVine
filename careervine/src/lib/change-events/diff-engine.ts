/**
 * Scrape diff engine (plan 29 §5) — pure, no I/O.
 *
 * Given a contact's state before a scrape (current employment rows + the
 * latest prior snapshot) and the freshly scraped state, emit outreach-worthy
 * change events. The ingest layer persists them into contact_change_events,
 * where the existing Up Next reader surfaces tier 1/2 for active/prospect
 * contacts.
 *
 * Core rules (each traces to a deep-review finding or plan decision):
 *  - Employment pairs by resolved company_id FIRST, then compares titles/dates
 *    — never by the full natural key, or a title rewording reads as a change.
 *  - False-positive guard: a Tier-1 "company change" requires LinkedIn company
 *    ids on both sides that differ. A name-only company match ("Domo" vs
 *    "Domo, Inc." creating a second row) must never fire a congrats.
 *  - First-enrichment rule: no prior state ⇒ no events. This applies to
 *    booleans explicitly — a contact already openToWork at first snapshot is
 *    baseline, not news.
 *  - Every event carries a stable dedupe key; the (user_id, dedupe_key) unique
 *    index makes producers idempotent and dismissals permanent.
 */

import { ChangeEventType, ChangeEventTier } from "@/lib/constants";
import type { ApifyProfileItem } from "@/lib/apify/client";

// ── Snapshot shape (stored in contact_scrape_snapshots.snapshot) ───────

export interface SnapshotEmployment {
  company_id: number;
  linkedin_company_id: string | null;
  company_name: string | null;
  title: string | null;
  start_month: string | null;
  is_current: boolean;
}

export interface ScrapeSnapshot {
  headline: string | null;
  location_text: string | null;
  open_to_work: boolean | null; // null = not captured
  hiring: boolean | null;
  has_photo: boolean;
  certifications: string[]; // names only
  employment: SnapshotEmployment[];
}

/** Build the normalized snapshot from a raw actor item + resolved employment. */
export function buildSnapshot(
  item: ApifyProfileItem,
  employment: SnapshotEmployment[],
): ScrapeSnapshot {
  const certs: string[] = [];
  const rawCerts = (item as { certifications?: unknown }).certifications;
  if (Array.isArray(rawCerts)) {
    for (const c of rawCerts) {
      const name = typeof c === "string" ? c : (c as { name?: string; title?: string })?.name ?? (c as { title?: string })?.title;
      if (name && String(name).trim()) certs.push(String(name).trim());
    }
  }
  return {
    headline: item.headline?.trim() || null,
    location_text: item.location?.linkedinText?.trim() || null,
    open_to_work: typeof (item as { openToWork?: unknown }).openToWork === "boolean" ? Boolean((item as { openToWork?: boolean }).openToWork) : null,
    hiring: typeof (item as { hiring?: unknown }).hiring === "boolean" ? Boolean((item as { hiring?: boolean }).hiring) : null,
    has_photo: Boolean(item.photo?.trim()),
    certifications: certs,
    employment,
  };
}

// ── Diff input / output ────────────────────────────────────────────────

export interface DiffInput {
  contactId: number;
  contactName: string;
  /** ISO date of the scrape (used in recurrence-safe dedupe keys). */
  scrapedAt: string;
  /** Contact's employment rows in the DB before the merge. */
  existingEmployment: Array<{
    company_id: number;
    title: string | null;
    start_month: string | null;
    is_current: boolean;
  }>;
  /** linkedin_company_id per companies.id, for BOTH sides' companies. */
  companyLinkedinIds: Map<number, string | null>;
  /** Latest snapshot before this scrape, if any. */
  prevSnapshot: ScrapeSnapshot | null;
  /** Snapshot built from this scrape. */
  nextSnapshot: ScrapeSnapshot;
}

export interface DiffEvent {
  contactId: number;
  type: string;
  tier: number;
  dedupeKey: string;
  headline: string;
  evidence: string;
  suggestedTitle: string;
  suggestedDescription: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
}

// ── Engine ─────────────────────────────────────────────────────────────

export function computeDiff(input: DiffInput): DiffEvent[] {
  const events: DiffEvent[] = [];
  const { contactId, contactName, prevSnapshot: prev, nextSnapshot: next } = input;

  // ── Employment: company-level pairing ──
  // First-enrichment rule: a contact with no stored employment has no baseline.
  if (input.existingEmployment.length > 0) {
    const prevCurrent = new Map<number, { title: string | null; start_month: string | null }>();
    for (const row of input.existingEmployment) {
      if (row.is_current && !prevCurrent.has(row.company_id)) {
        prevCurrent.set(row.company_id, { title: row.title, start_month: row.start_month });
      }
    }
    const prevCompanies = new Set(input.existingEmployment.map((r) => r.company_id));
    const prevCurrentLinkedinIds = new Set(
      [...prevCurrent.keys()]
        .map((id) => input.companyLinkedinIds.get(id))
        .filter((v): v is string => Boolean(v)),
    );

    const seenNextCompanies = new Set<number>();
    for (const emp of next.employment) {
      if (!emp.is_current || seenNextCompanies.has(emp.company_id)) continue;
      seenNextCompanies.add(emp.company_id);

      const prevRole = prevCurrent.get(emp.company_id);
      if (prevRole) {
        // Same company still current: promotion = new title AND new start month
        // (a fresh stint). Title-only rewording is noise; date-only is a
        // correction.
        const titleChanged = normalize(prevRole.title) !== normalize(emp.title) && emp.title != null && prevRole.title != null;
        // Null-baseline rule (same as titles/booleans): a start month appearing
        // where none was known is enrichment, not a new stint.
        const startChanged =
          normalize(prevRole.start_month) !== normalize(emp.start_month) &&
          emp.start_month != null &&
          prevRole.start_month != null;
        if (titleChanged && startChanged) {
          const companyName = emp.company_name ?? "their company";
          events.push({
            contactId,
            type: ChangeEventType.Promotion,
            tier: ChangeEventTier.ActNow,
            dedupeKey: `promotion:${contactId}:${emp.company_id}:${normalize(emp.start_month)}`,
            headline: `${contactName} is now ${emp.title} at ${companyName}`,
            evidence: `Was ${prevRole.title} · New role started ${emp.start_month}`,
            suggestedTitle: `Congratulate ${contactName} on the new role`,
            suggestedDescription: `${contactName} moved from ${prevRole.title} to ${emp.title} at ${companyName}, a natural moment for a congrats note.`,
            oldValue: { title: prevRole.title, start_month: prevRole.start_month },
            newValue: { title: emp.title, start_month: emp.start_month },
          });
        }
        continue;
      }

      // New current company. False-positive guard: require a LinkedIn id on
      // the new company that differs from every prior current company's id —
      // a name-mismatch duplicate row must never fire a congrats.
      if (!emp.linkedin_company_id) continue;
      if (prevCurrentLinkedinIds.has(emp.linkedin_company_id)) continue;
      // If prior current roles exist but none carries a LinkedIn id, we can't
      // prove difference — downgrade to silence rather than risk a false one.
      const priorCurrentWithoutIds =
        prevCurrent.size > 0 && prevCurrentLinkedinIds.size === 0;
      if (priorCurrentWithoutIds) continue;

      const companyName = emp.company_name ?? "a new company";
      const returning = prevCompanies.has(emp.company_id);
      events.push({
        contactId,
        type: ChangeEventType.CompanyChange,
        tier: ChangeEventTier.ActNow,
        dedupeKey: `company_change:${contactId}:${emp.linkedin_company_id}`,
        headline: returning
          ? `${contactName} is back at ${companyName}`
          : `${contactName} just joined ${companyName}${emp.title ? ` as ${emp.title}` : ""}`,
        evidence: `${emp.title ?? "New role"}${emp.start_month ? ` · Started ${emp.start_month}` : ""}`,
        suggestedTitle: `Congratulate ${contactName} on joining ${companyName}`,
        suggestedDescription: `${contactName} started ${emp.title ? `as ${emp.title} ` : ""}at ${companyName}. Congrats notes land best early in a new role.`,
        oldValue: null,
        newValue: { company: companyName, title: emp.title, start_month: emp.start_month },
      });
    }
  }

  // ── Snapshot-based signals: need a prior snapshot as the baseline ──
  if (prev) {
    const day = input.scrapedAt.slice(0, 10);

    // Boolean flips: only false → true is news (explicitly not null → true).
    if (prev.open_to_work === false && next.open_to_work === true) {
      events.push({
        contactId,
        type: ChangeEventType.OpenToWork,
        tier: ChangeEventTier.ActNow,
        dedupeKey: `open_to_work:${contactId}:${day}`,
        headline: `${contactName} is now open to work`,
        evidence: "LinkedIn OpenToWork flag turned on",
        suggestedTitle: `Check in with ${contactName} about their search`,
        suggestedDescription: `${contactName} flagged themselves open to work. A supportive check-in or intro offer lands well right now.`,
        oldValue: { open_to_work: false },
        newValue: { open_to_work: true },
      });
    }
    if (prev.hiring === false && next.hiring === true) {
      events.push({
        contactId,
        type: ChangeEventType.Hiring,
        tier: ChangeEventTier.ActNow,
        dedupeKey: `hiring:${contactId}:${day}`,
        headline: `${contactName} is hiring`,
        evidence: "LinkedIn Hiring flag turned on",
        suggestedTitle: `Ask ${contactName} about their open roles`,
        suggestedDescription: `${contactName} turned on the Hiring badge, a direct opening to ask what they're hiring for.`,
        oldValue: { hiring: false },
        newValue: { hiring: true },
      });
    }

    // Location change (Tier 2). Dedupe on the new value so an unpersisted
    // change can't re-fire every month (deep-review M3 backstop).
    const prevLoc = normalize(prev.location_text);
    const nextLoc = normalize(next.location_text);
    if (prevLoc && nextLoc && prevLoc !== nextLoc) {
      events.push({
        contactId,
        type: ChangeEventType.LocationChange,
        tier: ChangeEventTier.Touchpoint,
        dedupeKey: `location_change:${contactId}:${nextLoc}`,
        headline: `${contactName} moved to ${next.location_text}`,
        evidence: `Was ${prev.location_text}`,
        suggestedTitle: `Ask ${contactName} about the move`,
        suggestedDescription: `${contactName}'s profile location changed from ${prev.location_text} to ${next.location_text}, an easy personal touchpoint.`,
        oldValue: { location: prev.location_text },
        newValue: { location: next.location_text },
      });
    }

    // New certifications (Tier 2).
    const prevCerts = new Set(prev.certifications.map((c) => normalize(c)));
    for (const cert of next.certifications) {
      const key = normalize(cert);
      if (!key || prevCerts.has(key)) continue;
      events.push({
        contactId,
        type: ChangeEventType.Certification,
        tier: ChangeEventTier.Touchpoint,
        dedupeKey: `certification:${contactId}:${key}`,
        headline: `${contactName} earned a certification: ${cert}`,
        evidence: "New on their LinkedIn profile",
        suggestedTitle: `Congratulate ${contactName} on the certification`,
        suggestedDescription: `${contactName} added "${cert}" to their profile, a small win worth acknowledging.`,
        oldValue: null,
        newValue: { certification: cert },
      });
    }
  }

  return events;
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
