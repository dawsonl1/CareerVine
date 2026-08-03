/**
 * SchoolAutocomplete — university name input with predictive suggestions.
 *
 * The list moved to @/lib/schools/university-list in CAR-213 so the account
 * picker and the contact forms share ONE set of school names. A second list
 * would mean a user meets one input on their own profile and a different one
 * on every contact they edit, with different coverage and different
 * normalization, and matching then behaves inexplicably.
 *
 * `allowCustom` adds the explicit escape-hatch row and reports, via
 * onChange's second argument, whether the committed value came from the
 * curated list or was typed. The account picker needs that distinction
 * (users.university_is_custom drives which values get promoted into the list
 * later); the contact forms do not and leave it off, keeping their behaviour
 * exactly as it was.
 *
 * Used in: contact create/edit forms, signup, Settings → Account.
 */

"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useDropdownEscape } from "@/hooks/use-dropdown-escape";
import { GraduationCap, Plus } from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { UNIVERSITY_NAMES } from "@/lib/schools/university-list";
import { normalizeSchoolName } from "@/lib/schools/affinity";

interface SchoolAutocompleteProps {
  value: string;
  /** `isCustom` is true when the value was typed rather than picked. */
  onChange: (value: string, isCustom: boolean) => void;
  placeholder?: string;
  className?: string;
  /** Show the "Add …" row for schools not on the list (CAR-213). */
  allowCustom?: boolean;
  id?: string;
}

export function SchoolAutocomplete({
  value,
  onChange,
  placeholder = "e.g. Stanford University",
  className,
  allowCustom = false,
  id,
}: SchoolAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const trimmed = query.trim();

  const filtered = useMemo(
    () =>
      trimmed.length >= 2
        ? UNIVERSITY_NAMES.filter((u) => u.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 8)
        : [],
    [trimmed],
  );

  // Offer the escape hatch only when what they typed is not already an exact
  // curated entry — normalized, so "byu" does not offer to "add" a school the
  // list already has under a different casing.
  const exactMatch = useMemo(() => {
    if (!trimmed) return false;
    const n = normalizeSchoolName(trimmed);
    return UNIVERSITY_NAMES.some((u) => normalizeSchoolName(u) === n);
  }, [trimmed]);

  const showCustomRow = allowCustom && trimmed.length >= 2 && !exactMatch;

  // Escape closes this list, not the dialog around it (CAR-205 review).
  const handleEscape = useDropdownEscape(open, setOpen);

  const commit = (next: string, isCustom: boolean) => {
    onChange(next, isCustom);
    setQuery(next);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative" onKeyDown={handleEscape}>
      <div className="relative">
        <input
          id={id}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Typing is provisional: report it as custom until a curated row
            // is picked, so an abandoned half-typed value is never recorded as
            // a list selection.
            onChange(e.target.value, true);
            setOpen(true);
          }}
          onFocus={() => { if (filtered.length > 0 || showCustomRow) setOpen(true); }}
          className={className || "w-full h-14 px-4 pr-10 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"}
          placeholder={placeholder}
          autoComplete="off"
        />
        <GraduationCap className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
      </div>
      {open && (filtered.length > 0 || showCustomRow) && (
        <div className="absolute z-50 mt-1 left-0 w-full bg-surface-container-high rounded-[12px] shadow-lg border border-outline-variant overflow-hidden animate-in fade-in-0 zoom-in-95">
          {filtered.map((uni) => (
            <button
              key={uni}
              type="button"
              onClick={() => commit(uni, false)}
              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer transition-colors"
            >
              {uni}
            </button>
          ))}
          {showCustomRow && (
            <button
              type="button"
              onClick={() => commit(trimmed, true)}
              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer transition-colors border-t border-outline-variant/50 flex items-center gap-2"
            >
              <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">Add &ldquo;{trimmed}&rdquo;</span>
            </button>
          )}
        </div>
      )}
      {allowCustom && filtered.length === 0 && trimmed.length >= 2 && (
        <p className="text-xs text-muted-foreground mt-1">
          No match. Pick &ldquo;Add {trimmed}&rdquo; to use it anyway.
        </p>
      )}
    </div>
  );
}
