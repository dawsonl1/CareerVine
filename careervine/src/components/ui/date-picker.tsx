/**
 * M3 DatePicker component
 *
 * A calendar-based date picker that renders as a popover.
 * Value format: YYYY-MM-DD string.
 *
 * Features:
 *   - Month/year navigation with chevron buttons
 *   - Today highlight
 *   - Selected date highlight in primary color
 *   - Click-outside to close
 *   - Clear button to reset value
 *   - Supports required prop for form validation
 */

"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function DatePicker({ value, onChange, required, placeholder = "Select date" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const today = new Date();
  const selected = value ? new Date(value + "T00:00:00") : null;
  const [viewYear, setViewYear] = useState(selected?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected?.getMonth() ?? today.getMonth());

  // Close on outside click — check both the trigger container and the portaled dropdown
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Position the dropdown relative to the trigger button
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownHeight = 380; // approximate max height
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow >= dropdownHeight ? rect.bottom + 8 : rect.top - dropdownHeight - 8;
    setDropdownPos({ top: Math.max(8, top), left: Math.max(8, Math.min(rect.left, window.innerWidth - 316)) });
  }, [open]);

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  const selectDay = (day: number) => {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  };

  const isToday = (day: number) =>
    viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();

  const isSelected = (day: number) =>
    selected && viewYear === selected.getFullYear() && viewMonth === selected.getMonth() && day === selected.getDate();

  const displayValue = selected
    ? selected.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  return (
    <div ref={ref} className="relative">
      {/* Hidden native input for form validation */}
      <input type="text" value={value} required={required} readOnly tabIndex={-1}
        className="absolute inset-0 opacity-0 pointer-events-none" />

      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2"
      >
        <span className={displayValue ? "text-foreground" : "text-muted-foreground"}>
          {displayValue || placeholder}
        </span>
        <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
      </button>

      {/* Dropdown calendar — rendered via portal to avoid overflow clipping */}
      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] w-[300px] bg-surface-container-high rounded-[16px] shadow-lg border border-outline-variant p-4 animate-in fade-in-0 zoom-in-95"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Month/year header */}
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={prevMonth} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm font-medium text-foreground">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={nextMonth} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[11px] font-medium text-muted-foreground py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {/* Empty cells before first day */}
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`e-${i}`} />
            ))}
            {/* Day cells */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const sel = isSelected(day);
              const tod = isToday(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => selectDay(day)}
                  className={`
                    state-layer h-10 w-10 mx-auto rounded-full flex items-center justify-center text-sm cursor-pointer transition-colors
                    ${sel
                      ? "bg-primary text-primary-foreground font-medium"
                      : tod
                        ? "border border-primary text-primary font-medium"
                        : "text-foreground hover:bg-surface-container"
                    }
                  `}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Today shortcut */}
          <div className="mt-3 pt-3 border-t border-outline-variant flex justify-end">
            <button
              type="button"
              onClick={() => {
                setViewYear(today.getFullYear());
                setViewMonth(today.getMonth());
                selectDay(today.getDate());
              }}
              className="text-xs font-medium text-primary hover:underline px-2 py-1 cursor-pointer"
            >
              Today
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
