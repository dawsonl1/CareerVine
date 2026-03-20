/**
 * MonthYearPicker — month and year selector (no day)
 *
 * Used for graduation dates and other month-level precision fields.
 * Value format: YYYY-MM string (e.g. "2026-05").
 *
 * Features:
 *   - Year navigation with chevron buttons
 *   - 3×4 month grid
 *   - Click-outside to close
 *   - Clear button to reset value
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";

interface MonthYearPickerProps {
  value: string; // YYYY-MM format
  onChange: (value: string) => void;
  placeholder?: string;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function MonthYearPicker({ value, onChange, placeholder = "Select month" }: MonthYearPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const today = new Date();
  const selectedYear = value ? parseInt(value.split("-")[0]) : null;
  const selectedMonth = value ? parseInt(value.split("-")[1]) - 1 : null;
  const [viewYear, setViewYear] = useState(selectedYear ?? today.getFullYear());

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const selectMonth = (monthIdx: number) => {
    const m = String(monthIdx + 1).padStart(2, "0");
    onChange(`${viewYear}-${m}`);
    setOpen(false);
  };

  const displayValue =
    selectedYear !== null && selectedMonth !== null
      ? `${MONTH_FULL[selectedMonth]} ${selectedYear}`
      : "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2"
      >
        <span className={displayValue ? "text-foreground" : "text-muted-foreground"}>
          {displayValue || placeholder}
        </span>
        <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 left-0 w-[280px] bg-surface-container-high rounded-[16px] shadow-lg border border-outline-variant p-4 animate-in fade-in-0 zoom-in-95">
          <div className="flex items-center justify-between mb-4">
            <button type="button" onClick={() => setViewYear(viewYear - 1)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm font-medium text-foreground">{viewYear}</span>
            <button type="button" onClick={() => setViewYear(viewYear + 1)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {MONTHS.map((label, idx) => {
              const sel = selectedYear === viewYear && selectedMonth === idx;
              return (
                <button
                  key={idx}
                  type="button"
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
        </div>
      )}
    </div>
  );
}
