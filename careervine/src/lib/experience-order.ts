/**
 * Chronological ordering for a contact's experience and education (CAR-216).
 *
 * THE ORDER A JOIN ARRIVES IN IS NOT AN ORDER. `contact_companies` embeds carry
 * no ORDER BY, so Postgres serves the FK lookup from
 * `contact_companies_unique_idx (contact_id, company_id, start_date)` and the
 * rows arrive sorted by `company_id` — the order the app first created that
 * company anywhere in the account, which has nothing to do with this person's
 * timeline. Companies already in the DB before a contact was scraped float to
 * the top of their profile, a job change captured later at a company new to the
 * account renders last, and none of it is guaranteed: it is a planner choice
 * that can change under us. `contact_schools` has the same shape via
 * `contact_schools_unique_idx`.
 *
 * So every surface that shows work history sorts through here, and every
 * "what do they do now" pick goes through `primaryCurrentRole` rather than
 * `.find(cc => cc.is_current)`, which returns whatever the planner put first.
 *
 * PARSING IS DELIBERATELY TOLERANT. `start_month`/`end_month` are TEXT, and the
 * schema comment's "Mon YYYY" is only what the scrapers write. A survey of 1000
 * production rows found `Mon YYYY` (847), bare `YYYY` (66), `Present` (182 of
 * the end values), ~40 user-typed month names with NO year at all (`Jul`,
 * `June`), and ~11 truncated values (`December 202`). The real `start_date`
 * column is populated on ZERO rows, so it is not a fallback.
 *
 * A 4-digit year is therefore the ONE thing a value must have to be orderable.
 * Anything without one parses as null rather than as a guess — `December 202`
 * is not the year 202, and a bare `Jul` belongs to no year we know. Those rows
 * fall back to their end month and otherwise sort last, which is the honest
 * answer: we do not know when they happened.
 */

/** Month names as written by the scrapers and by hand, abbreviated or full. */
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const YEAR = /\b(19\d{2}|20\d{2})\b/;
/** `2023-01`, `2023/1` */
const ISO_MONTH = /\b(?:19\d{2}|20\d{2})[-/](\d{1,2})\b/;
/** `01/2023`, `1-2023` */
const MONTH_FIRST = /\b(\d{1,2})[-/](?:19\d{2}|20\d{2})\b/;
const WORD = /[a-z]{3,9}/g;

/**
 * Parse an employment month into a sortable integer, `year * 100 + month`.
 *
 * Month is 0 when the value carries only a year, so a dated month outranks a
 * bare year within the same year (`Jun 2023` is newer than `2023`). Returns
 * null when there is no 4-digit year — including for `Present`, which is a
 * marker, not a date. The first year in the string wins, so a range typed into
 * one field (`2021-2023`) reads as its start.
 */
export function parseExperienceMonth(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;

  const year = YEAR.exec(text);
  if (!year) return null;

  return Number(year[1]) * 100 + monthOf(text);
}

/** 1-12, or 0 when the text names no month we recognize. */
function monthOf(text: string): number {
  const numeric = ISO_MONTH.exec(text) ?? MONTH_FIRST.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month >= 1 && month <= 12) return month;
  }

  WORD.lastIndex = 0;
  for (let word = WORD.exec(text); word; word = WORD.exec(text)) {
    const month = MONTH_NUMBERS[word[0]];
    if (month) return month;
  }
  return 0;
}

/** The employment fields ordering reads. Any row carrying them can be sorted. */
export interface ExperienceOrderRow {
  is_current?: boolean | null;
  start_month?: string | null;
  end_month?: string | null;
}

/** The education fields ordering reads. */
export interface EducationOrderRow {
  start_year?: number | null;
  end_year?: number | null;
}

/** Descending, with null (unknown) always last regardless of direction. */
function byRecency(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Order work history the way a reader expects it: current roles first, then
 * newest start first, undated last.
 *
 * A row with no parseable start ranks on its END month instead, so a half-dated
 * row lands near its real place rather than at the bottom. Ties fall through to
 * end month and finally to input order, making the comparator a total order —
 * the output depends only on the input, never on how the row happened to arrive.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortExperiences<T extends ExperienceOrderRow>(rows: readonly T[]): T[] {
  // Decorate-sort-undecorate: parse each row once instead of on every compare.
  return rows
    .map((row, index) => ({
      row,
      index,
      current: row.is_current === true,
      start: parseExperienceMonth(row.start_month),
      end: parseExperienceMonth(row.end_month),
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        byRecency(a.start ?? a.end, b.start ?? b.end) ||
        byRecency(a.end, b.end) ||
        a.index - b.index,
    )
    .map((ranked) => ranked.row);
}

/**
 * The role to show as "what they do now": the newest-starting current role.
 *
 * Replaces `.find(cc => cc.is_current)`, which on anyone holding several
 * concurrent roles (board seats, advisories) returned whichever the planner
 * happened to put first. Undefined when no role is marked current.
 */
export function primaryCurrentRole<T extends ExperienceOrderRow>(
  rows: readonly T[],
): T | undefined {
  const [first] = sortExperiences(rows);
  return first?.is_current === true ? first : undefined;
}

/**
 * Order education newest first, on end year then start year, undated last.
 *
 * These are real integer columns, so there is nothing to parse — but the rows
 * arrive in `school_id` order for the same reason the employment rows arrive in
 * `company_id` order, so they need sorting just as much.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortEducation<T extends EducationOrderRow>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        byRecency(a.row.end_year ?? a.row.start_year ?? null, b.row.end_year ?? b.row.start_year ?? null) ||
        byRecency(a.row.start_year ?? null, b.row.start_year ?? null) ||
        a.index - b.index,
    )
    .map((ranked) => ranked.row);
}
