"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { usePortalDropdown } from "@/hooks/use-portal-dropdown";
import {
  calendarAnchorFromApplicationDate,
  formatApplicationDateDisplay,
  todayApplicationDateIso,
  toApplicationDateIso,
} from "@/lib/application-date-value";

const DROPDOWN_WIDTH = 280;
const DROPDOWN_HEIGHT = 340;

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface ApplicationDatePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  className?: string;
}

function ApplicationDateCalendar({
  viewYear,
  viewMonth,
  selectedDay,
  onPrevMonth,
  onNextMonth,
  onSelectDay,
}: {
  viewYear: number;
  viewMonth: number;
  selectedDay: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectDay: (iso: string) => void;
}) {
  const today = new Date();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onPrevMonth}
          className="state-layer p-1.5 rounded-full text-on-surface-variant hover:text-on-surface"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-on-surface">
          {MONTH_LABELS[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          onClick={onNextMonth}
          className="state-layer p-1.5 rounded-full text-on-surface-variant hover:text-on-surface"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {DAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-on-surface-variant py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const iso = toApplicationDateIso(viewYear, viewMonth, day);
          const isToday =
            viewYear === today.getFullYear() &&
            viewMonth === today.getMonth() &&
            day === today.getDate();
          const isSelected = selectedDay === iso;

          const dayClassName = [
            "h-8 w-8 mx-auto text-xs rounded-full transition-all duration-150",
            isSelected
              ? "bg-primary text-on-primary font-medium hover:bg-primary/90 hover:shadow-sm"
              : isToday
                ? "border border-primary text-primary font-medium hover:bg-primary-container hover:text-on-primary-container hover:border-primary"
                : "text-on-surface hover:bg-primary-container/70 hover:text-on-primary-container",
          ].join(" ");

          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelectDay(iso)}
              className={dayClassName}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ApplicationDatePicker({
  value,
  onChange,
  placeholder = "Select date",
  dialogTitle = "Date",
  dialogDescription = "Pick a date from the calendar",
  className,
}: ApplicationDatePickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { open, setOpen, toggle, triggerRef, dropdownRef, dropdownPos } = usePortalDropdown(
    containerRef,
    { dropdownHeight: DROPDOWN_HEIGHT, dropdownWidth: DROPDOWN_WIDTH },
  );

  const anchor = calendarAnchorFromApplicationDate(value);
  const [viewYear, setViewYear] = useState(anchor.year);
  const [viewMonth, setViewMonth] = useState(anchor.month);

  useEffect(() => {
    if (!open) return;
    const next = calendarAnchorFromApplicationDate(value);
    setViewYear(next.year);
    setViewMonth(next.month);
  }, [open, value]);

  const display = formatApplicationDateDisplay(value);

  const selectDay = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const setToday = () => {
    const iso = todayApplicationDateIso();
    const next = calendarAnchorFromApplicationDate(iso);
    setViewYear(next.year);
    setViewMonth(next.month);
    onChange(iso);
    setOpen(false);
  };

  const clearDate = () => {
    onChange("");
    setOpen(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
      return;
    }
    setViewMonth((m) => m - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
      return;
    }
    setViewMonth((m) => m + 1);
  };

  return (
    <div ref={containerRef} className={className}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-left flex items-center justify-between gap-2 transition-colors hover:border-outline-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
      >
        <span className={display ? "text-on-surface truncate" : "text-on-surface-variant/60 truncate"}>
          {display || placeholder}
        </span>
        <Calendar className="w-4 h-4 text-on-surface-variant shrink-0" />
      </button>

      {open &&
        dropdownPos &&
        createPortal(
          <div
            ref={dropdownRef}
            role="dialog"
            aria-label={dialogTitle}
            className="fixed z-[200] w-[280px] rounded-xl border border-outline-variant/50 bg-surface-container-lowest shadow-lg overflow-hidden"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-3 border-b border-outline-variant/30">
              <p className="text-sm font-medium text-on-surface">{dialogTitle}</p>
              <p className="text-xs text-on-surface-variant mt-0.5">{dialogDescription}</p>
            </div>

            <div className="p-4">
              <ApplicationDateCalendar
                viewYear={viewYear}
                viewMonth={viewMonth}
                selectedDay={value}
                onPrevMonth={prevMonth}
                onNextMonth={nextMonth}
                onSelectDay={selectDay}
              />
            </div>

            <div className="px-4 pb-4 pt-1 border-t border-outline-variant/30 flex items-center justify-between gap-2">
              {value ? (
                <button
                  type="button"
                  onClick={clearDate}
                  className="text-xs font-medium text-on-surface-variant hover:text-error px-2 py-1"
                >
                  Clear
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={setToday}
                className="text-xs font-medium text-primary hover:underline px-2 py-1"
              >
                Today
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
