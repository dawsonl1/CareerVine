/**
 * Work-anniversary change events (plan 29 phase 0).
 *
 * Pure, no-I/O computation: given a contact's current employment rows (each
 * carrying a stored "Mon YYYY" start_month), decide whether *this month* is a
 * whole-year work anniversary worth an outreach touch, and emit a candidate
 * change event.
 *
 * We only have month granularity (start_month is text), so an anniversary
 * fires for the whole calendar month it falls in; the dedupe key includes the
 * anniversary year so the persisted-events layer surfaces it exactly once per
 * year. Rows without a parseable month are skipped — no scraping, no guessing.
 */

import { ChangeEventType, ChangeEventTier } from "@/lib/constants";

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export interface ParsedMonth {
  month: number; // 0-11
  year: number;
}

/**
 * Parse a stored start_month into {month, year}. Returns null when there is no
 * usable month component — bare years ("2021"), "Present", empty, or garbage.
 * Accepts "Mar 2021", "March 2021", "Mar. 2021", and is whitespace/comma tolerant.
 */
export function parseStartMonth(raw: string | null | undefined): ParsedMonth | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned === "present") return null;

  // Split into word-ish tokens (handles "mar 2021", "march, 2021", "mar. 2021")
  const tokens = cleaned.replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);

  let month: number | null = null;
  let year: number | null = null;
  for (const tok of tokens) {
    if (month === null && tok in MONTHS) {
      month = MONTHS[tok];
      continue;
    }
    if (year === null && /^\d{4}$/.test(tok)) {
      year = parseInt(tok, 10);
    }
  }

  if (month === null || year === null) return null;
  if (year < 1900 || year > 2100) return null;
  return { month, year };
}

export interface AnniversaryEmployment {
  company_id: number | null;
  company_name: string | null;
  start_month: string | null;
  is_current: boolean | null;
}

export interface AnniversaryContact {
  id: number;
  name: string;
  photo_url: string | null;
  industry: string | null;
  employment: AnniversaryEmployment[];
}

export interface AnniversaryEvent {
  contactId: number;
  type: string;
  tier: number;
  dedupeKey: string;
  headline: string;
  evidence: string;
  suggestedTitle: string;
  suggestedDescription: string;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/**
 * Emit anniversary events for a single contact whose whole-year work
 * anniversary at a current company falls in `today`'s month.
 *
 * A contact can hold multiple concurrent current roles; each qualifying one
 * yields its own event (distinct company → distinct dedupe key).
 */
export function computeAnniversaryEventsForContact(
  contact: AnniversaryContact,
  today: Date = new Date(),
): AnniversaryEvent[] {
  const events: AnniversaryEvent[] = [];
  const todayMonth = today.getMonth();
  const todayYear = today.getFullYear();

  for (const emp of contact.employment) {
    if (!emp.is_current) continue;
    if (emp.company_id == null) continue; // need a stable id for the dedupe key

    const parsed = parseStartMonth(emp.start_month);
    if (!parsed) continue;
    if (parsed.month !== todayMonth) continue; // anniversary month only

    const years = todayYear - parsed.year;
    if (years < 1) continue; // not yet a full year (or a future/typo date)

    const companyName = emp.company_name?.trim() || "their company";
    events.push({
      contactId: contact.id,
      type: ChangeEventType.Anniversary,
      tier: ChangeEventTier.Touchpoint,
      dedupeKey: `anniversary:${contact.id}:${emp.company_id}:${todayYear}`,
      headline: `${contact.name} hits ${years} year${years === 1 ? "" : "s"} at ${companyName} this month`,
      evidence: `Started ${emp.start_month} · ${ordinal(years)} work anniversary`,
      suggestedTitle: `Congratulate ${contact.name} on ${years} year${years === 1 ? "" : "s"} at ${companyName}`,
      suggestedDescription: `${contact.name} reaches ${years} year${years === 1 ? "" : "s"} at ${companyName} this month, a natural, low-pressure reason to reconnect.`,
    });
  }

  return events;
}

/** Compute anniversary events across many contacts. */
export function computeAnniversaryEvents(
  contacts: AnniversaryContact[],
  today: Date = new Date(),
): AnniversaryEvent[] {
  return contacts.flatMap((c) => computeAnniversaryEventsForContact(c, today));
}
