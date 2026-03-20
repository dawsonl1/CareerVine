/**
 * DegreeAutocomplete — degree abbreviation input with suggestions
 *
 * Contains a list of common degree abbreviations (B.A., M.S., Ph.D., etc.).
 * Filters as the user types; allows custom values not in the list.
 *
 * Used in: contact create/edit form (degree field)
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";

const DEGREES = [
  "A.A.", "A.A.S.", "A.S.",
  "B.A.", "B.B.A.", "B.F.A.", "B.S.", "B.S.E.", "B.S.N.",
  "M.A.", "M.B.A.", "M.Ed.", "M.F.A.", "M.P.A.", "M.P.H.",
  "M.S.", "M.S.W.",
  "D.D.S.", "D.M.D.", "D.O.", "Ed.D.", "J.D.", "M.D.",
  "Pharm.D.", "Ph.D.",
  "Certificate", "Diploma",
];

interface DegreeAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function DegreeAutocomplete({
  value,
  onChange,
  placeholder = "e.g. B.S., M.B.A.",
  className,
}: DegreeAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const filtered = query.trim().length >= 1
    ? DEGREES.filter((d) =>
        d.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 8)
    : [];

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => { if (filtered.length > 0) setOpen(true); }}
        className={className || "w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 left-0 w-full bg-surface-container-high rounded-[12px] shadow-lg border border-outline-variant overflow-hidden animate-in fade-in-0 zoom-in-95">
          {filtered.map((deg) => (
            <button
              key={deg}
              type="button"
              onClick={() => {
                onChange(deg);
                setQuery(deg);
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer transition-colors"
            >
              {deg}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
