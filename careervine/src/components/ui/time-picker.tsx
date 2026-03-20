/**
 * M3 TimePicker component
 *
 * A clock-face time picker with 12-hour AM/PM display.
 * Value format: HH:MM in 24-hour time (e.g. "14:30").
 *
 * Features:
 *   - Visual clock face for hour selection
 *   - Minute grid (5-minute increments)
 *   - AM/PM toggle
 *   - Click-outside to close
 *   - Clear button to reset value
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { usePortalDropdown } from "@/hooks/use-portal-dropdown";

interface TimePickerProps {
  value: string; // HH:MM (24h)
  onChange: (value: string) => void;
  placeholder?: string;
}

const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function to12(h24: number): { h12: number; period: "AM" | "PM" } {
  const period: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return { h12, period };
}

function to24(h12: number, period: "AM" | "PM"): number {
  if (period === "AM") return h12 === 12 ? 0 : h12;
  return h12 === 12 ? 12 : h12 + 12;
}

export function TimePicker({ value, onChange, placeholder = "Select time" }: TimePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { open, setOpen, toggle, triggerRef, dropdownRef, dropdownPos } = usePortalDropdown(ref, {
    dropdownHeight: 340,
    dropdownWidth: 280,
  });

  // Parse current value
  const parts = value ? value.split(":").map(Number) : [null, null];
  const currentH24 = parts[0];
  const currentMin = parts[1];

  const [period, setPeriod] = useState<"AM" | "PM">(
    currentH24 !== null && currentH24 >= 12 ? "PM" : "AM"
  );

  // Sync AM/PM toggle when parent changes value externally
  useEffect(() => {
    if (currentH24 !== null) {
      setPeriod(currentH24 >= 12 ? "PM" : "AM");
    }
  }, [currentH24]);

  const selectHour = (h12: number) => {
    const h24 = to24(h12, period);
    const min = currentMin ?? 0;
    onChange(`${String(h24).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  };

  const selectMinute = (min: number) => {
    const h24 = currentH24 ?? to24(12, period);
    onChange(`${String(h24).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  };

  const togglePeriod = (p: "AM" | "PM") => {
    setPeriod(p);
    if (currentH24 !== null) {
      const { h12 } = to12(currentH24);
      const newH24 = to24(h12, p);
      const min = currentMin ?? 0;
      onChange(`${String(newH24).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
    }
  };

  const displayValue = value && currentH24 !== null && currentMin !== null
    ? (() => {
        const { h12, period: p } = to12(currentH24);
        return `${h12}:${String(currentMin).padStart(2, "0")} ${p}`;
      })()
    : "";

  const selectedH12 = currentH24 !== null ? to12(currentH24).h12 : null;

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2"
      >
        <span className={displayValue ? "text-foreground" : "text-muted-foreground"}>
          {displayValue || placeholder}
        </span>
        <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
      </button>

      {/* Dropdown — rendered via portal to avoid overflow clipping */}
      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] w-[280px] bg-surface-container-high rounded-[16px] shadow-lg border border-outline-variant p-4 animate-in fade-in-0 zoom-in-95"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* AM/PM toggle */}
          <div className="flex items-center justify-center gap-1 mb-4">
            {(["AM", "PM"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => togglePeriod(p)}
                className={`px-5 py-2 rounded-full text-sm font-medium cursor-pointer transition-colors ${
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface-container text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Hours */}
          <p className="text-[11px] font-medium text-muted-foreground mb-2">Hour</p>
          <div className="grid grid-cols-6 gap-1 mb-4">
            {HOURS_12.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => selectHour(h)}
                className={`state-layer h-10 rounded-full flex items-center justify-center text-sm cursor-pointer transition-colors ${
                  selectedH12 === h
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-surface-container"
                }`}
              >
                {h}
              </button>
            ))}
          </div>

          {/* Minutes */}
          <p className="text-[11px] font-medium text-muted-foreground mb-2">Minute</p>
          <div className="grid grid-cols-6 gap-1">
            {MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { selectMinute(m); setOpen(false); }}
                className={`state-layer h-10 rounded-full flex items-center justify-center text-sm cursor-pointer transition-colors ${
                  currentMin === m
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-surface-container"
                }`}
              >
                {String(m).padStart(2, "0")}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
