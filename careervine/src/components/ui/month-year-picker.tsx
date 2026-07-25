/**
 * MonthYearPicker — month and year selector (no day)
 *
 * Used for `contacts.expected_graduation`, which the schema documents as free-form
 * text and which four different writers populate with four different shapes:
 *
 *   "2026-05"     this picker's own output
 *   "May 2027"    deriveContactStatus (lib/profile-helpers.ts, extension parity copy)
 *   "2027"        deriveContactStatusFromDates, which stores String(endYear)
 *   "2026-04-10"  full ISO dates, exercised by suggestion-generators.test.ts
 *
 * So `parseMonthYear` accepts all four rather than assuming the first (CAR-200). It
 * used to be a bare `parseInt`, which returns NaN on the extension's own output; the
 * guards then tested `!== null` and `??`, neither of which catches NaN, so the trigger
 * rendered "undefined NaN" and picking a month wrote back the literal string "NaN-05".
 *
 * A value that parses as nothing renders as itself. Falling back to the placeholder
 * would tell the user the field is empty while it holds data, which is how a value
 * gets silently overwritten — the Clear button is the deliberate way to discard one.
 *
 * Emitted values are always `YYYY-MM`. Downstream (`ai-followup/generate-suggestions.ts`)
 * reads the column with `new Date(value)`, which parses every shape above, so stored
 * data needs no normalization and gets none.
 *
 * Features:
 *   - Year navigation with chevron buttons
 *   - 3×4 month grid
 *   - Click-outside to close
 *   - Clear button to reset the value
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";

interface MonthYearPickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Accessible name. The trigger is a `<button>`, so a visible `<label>` cannot be
   * associated with it and its accessible name is its own text — which once a date is
   * chosen *is* the date. Same defect class as `Select`'s `ariaLabel` (CAR-201).
   */
  ariaLabel?: string;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Both the "Jan" and "January" spellings, lowercased, to their 0-based index. */
const MONTH_INDEX: Record<string, number> = Object.fromEntries([
  ...MONTHS.map((m, i) => [m.toLowerCase(), i] as const),
  ...MONTH_FULL.map((m, i) => [m.toLowerCase(), i] as const),
]);

/**
 * A stored graduation value as a year plus an optional month index (0-11).
 * `month` is null for a year-only value like "2027": known year, unknown month.
 */
export interface ParsedMonthYear {
  year: number;
  month: number | null;
}

/**
 * Parse any of the four stored shapes, or return null.
 *
 * Every numeric result is range-checked rather than merely non-NaN: "2026-13" and
 * "2026-00" are both well-formed enough for a regex and would index MONTH_FULL out of
 * bounds, putting `undefined` back on screen through a different door.
 */
export function parseMonthYear(value: string): ParsedMonthYear | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  // "2026-05" and "2026-04-10" — the day is dropped, this picker is month-precision.
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) {
    const month = Number(iso[2]) - 1;
    return month >= 0 && month <= 11 ? { year: Number(iso[1]), month } : null;
  }

  // "May 2027", "may 2027", "Sep 2027".
  const named = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTH_INDEX[named[1].toLowerCase()];
    return month !== undefined ? { year: Number(named[2]), month } : null;
  }

  // "2027".
  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) return { year: Number(yearOnly[1]), month: null };

  return null;
}

export function MonthYearPicker({ value, onChange, placeholder = "Select month", ariaLabel }: MonthYearPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const today = new Date();
  const parsed = parseMonthYear(value);

  /**
   * Seeded from the value and re-seeded on every open, rather than seeded once at
   * mount. These pickers stay mounted across contact changes, so a value arriving or
   * changing later would otherwise leave the calendar on a stale year.
   */
  const [viewYear, setViewYear] = useState(parsed?.year ?? today.getFullYear());

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const toggle = () => {
    if (!open) setViewYear(parsed?.year ?? today.getFullYear());
    setOpen(!open);
  };

  const selectMonth = (monthIdx: number) => {
    const m = String(monthIdx + 1).padStart(2, "0");
    onChange(`${viewYear}-${m}`);
    setOpen(false);
  };

  const clear = () => {
    onChange("");
    setOpen(false);
  };

  /**
   * Parsed values re-render canonically ("May 2027"); anything else shows verbatim so
   * the field never looks empty while holding data.
   */
  const displayValue = parsed
    ? parsed.month !== null
      ? `${MONTH_FULL[parsed.month]} ${parsed.year}`
      : String(parsed.year)
    : (value?.trim() ?? "");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2"
      >
        <span className={displayValue ? "text-foreground" : "text-muted-foreground"}>
          {displayValue || placeholder}
        </span>
        <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div
          // Non-modal dialog, matching the trigger's aria-haspopup. Without a role the
          // popup is an anonymous div and its year heading is indistinguishable from
          // the year the trigger itself may be showing.
          role="dialog"
          aria-label={ariaLabel}
          className="absolute z-50 mt-2 left-0 w-[280px] bg-surface-container-high rounded-[16px] shadow-lg border border-outline-variant p-4 animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-center justify-between mb-4">
            <button type="button" aria-label="Previous year" onClick={() => setViewYear(viewYear - 1)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm font-medium text-foreground">{viewYear}</span>
            <button type="button" aria-label="Next year" onClick={() => setViewYear(viewYear + 1)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {MONTHS.map((label, idx) => {
              const sel = parsed?.year === viewYear && parsed.month === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  aria-pressed={sel}
                  onClick={() => selectMonth(idx)}
                  className={`state-layer h-10 rounded-full flex items-center justify-center text-sm cursor-pointer transition-colors ${
                    sel
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-foreground hover:bg-surface-container"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Shown only when there is something to clear. While contact_status stays
              "student" this was the one state the form could not get back out of. */}
          {value?.trim() && (
            <button
              type="button"
              onClick={clear}
              className="mt-3 w-full h-9 rounded-full text-sm font-medium text-primary hover:bg-primary/8 cursor-pointer transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
