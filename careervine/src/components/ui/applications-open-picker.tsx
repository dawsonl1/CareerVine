"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Calendar,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePortalDropdown } from "@/hooks/use-portal-dropdown";
import {
  type ApplicationsOpenKind,
  type ApplicationsOpenValue,
  emptyApplicationsOpenValue,
  formatApplicationsOpenDisplay,
  normalizeRange,
  parseApplicationsOpenValue,
  serializeApplicationsOpenValue,
} from "@/lib/applications-open-value";

const DROPDOWN_WIDTH = 320;
const DROPDOWN_HEIGHT = 420;

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_OPTIONS: { id: ApplicationsOpenKind; label: string; icon: typeof Type }[] = [
  { id: "text", label: "Text", icon: Type },
  { id: "date", label: "Date", icon: Calendar },
  { id: "range", label: "Range", icon: CalendarRange },
  { id: "month", label: "Month", icon: CalendarDays },
];

interface ApplicationsOpenPickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthIso(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function calendarAnchorFromValue(parsed: ApplicationsOpenValue, raw: string) {
  const iso =
    parsed.date ||
    parsed.rangeStart ||
    parsed.rangeEnd ||
    parsed.month ||
    raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
    "";
  if (iso.length >= 7) {
    const [y, m] = iso.split("-").map(Number);
    if (y && m) return { year: y, month: m - 1 };
  }
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() };
}

function draftMatchesCommitted(draft: ApplicationsOpenValue, committedRaw: string): boolean {
  const normalized = draft.kind === "range" ? normalizeRange(draft) : draft;
  return serializeApplicationsOpenValue(normalized) === committedRaw;
}

function canCommitDraft(draft: ApplicationsOpenValue, committedRaw: string): boolean {
  if (draft.kind === "range" && (!draft.rangeStart || !draft.rangeEnd)) return false;
  return !draftMatchesCommitted(draft, committedRaw);
}

function CalendarGrid({
  viewYear,
  viewMonth,
  onPrevMonth,
  onNextMonth,
  onSelectDay,
  selectedDay,
  rangeStart,
  rangeEnd,
  mode,
  awaitingRangeEnd,
}: {
  viewYear: number;
  viewMonth: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectDay: (iso: string) => void;
  selectedDay?: string;
  rangeStart?: string;
  rangeEnd?: string;
  mode: "single" | "range";
  awaitingRangeEnd?: boolean;
}) {
  const today = new Date();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const rangeBounds =
    mode === "range" && rangeStart && rangeEnd
      ? rangeStart <= rangeEnd
        ? { start: rangeStart, end: rangeEnd }
        : { start: rangeEnd, end: rangeStart }
      : null;

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
          const iso = isoFromParts(viewYear, viewMonth, day);
          const isToday =
            viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();
          const isSelected = selectedDay === iso;
          const inRange =
            rangeBounds && iso >= rangeBounds.start && iso <= rangeBounds.end;
          const isRangeStart = rangeBounds?.start === iso;
          const isRangeEnd = rangeBounds?.end === iso;
          const isPendingRangeStart = awaitingRangeEnd && rangeStart === iso;

          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelectDay(iso)}
              className={`h-8 w-8 mx-auto text-xs rounded-full transition-colors ${
                isSelected || isRangeStart || isRangeEnd || isPendingRangeStart
                  ? `bg-primary text-on-primary font-medium${isPendingRangeStart ? " animate-range-start-pulse" : ""}`
                  : inRange
                    ? "bg-primary-container/60 text-on-surface"
                    : isToday
                      ? "border border-primary text-primary font-medium"
                      : "text-on-surface hover:bg-surface-container-high"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MonthGrid({
  viewYear,
  onPrevYear,
  onNextYear,
  selectedMonth,
  onSelectMonth,
}: {
  viewYear: number;
  onPrevYear: () => void;
  onNextYear: () => void;
  selectedMonth: string;
  onSelectMonth: (iso: string) => void;
}) {
  const selectedYear = selectedMonth ? parseInt(selectedMonth.split("-")[0], 10) : null;
  const selectedMonthIdx = selectedMonth ? parseInt(selectedMonth.split("-")[1], 10) - 1 : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onPrevYear}
          className="state-layer p-1.5 rounded-full text-on-surface-variant hover:text-on-surface"
          aria-label="Previous year"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-on-surface">{viewYear}</span>
        <button
          type="button"
          onClick={onNextYear}
          className="state-layer p-1.5 rounded-full text-on-surface-variant hover:text-on-surface"
          aria-label="Next year"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {MONTH_SHORT.map((label, idx) => {
          const selected = selectedYear === viewYear && selectedMonthIdx === idx;
          return (
            <button
              key={label}
              type="button"
              onClick={() => onSelectMonth(monthIso(viewYear, idx))}
              className={`h-9 rounded-lg text-xs font-medium transition-colors ${
                selected
                  ? "bg-primary text-on-primary"
                  : "text-on-surface hover:bg-surface-container-high"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ApplicationsOpenPicker({
  value,
  onChange,
  placeholder = "When do applications open?",
  className = "",
}: ApplicationsOpenPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { open, setOpen, triggerRef, dropdownRef, dropdownPos } = usePortalDropdown(containerRef, {
    dropdownHeight: DROPDOWN_HEIGHT,
    dropdownWidth: DROPDOWN_WIDTH,
  });

  const committedRef = useRef(value);
  const wasOpenRef = useRef(false);
  const [draft, setDraft] = useState<ApplicationsOpenValue>(() => parseApplicationsOpenValue(value));

  const anchorOnOpen = useMemo(
    () => calendarAnchorFromValue(parseApplicationsOpenValue(value), value),
    [value],
  );

  const [viewYear, setViewYear] = useState(anchorOnOpen.year);
  const [viewMonth, setViewMonth] = useState(anchorOnOpen.month);
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      committedRef.current = value;
      const parsed = parseApplicationsOpenValue(value);
      const anchor = calendarAnchorFromValue(parsed, value);
      setDraft(parsed);
      setViewYear(anchor.year);
      setViewMonth(anchor.month);
      setRangeAnchor(null);
    } else if (!open && wasOpenRef.current) {
      setDraft(parseApplicationsOpenValue(value));
      setRangeAnchor(null);
    }
    wasOpenRef.current = open;
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  const display = formatApplicationsOpenDisplay(value);

  const closeWithoutSaving = () => {
    setOpen(false);
  };

  const openPicker = () => {
    setOpen(true);
  };

  const apply = () => {
    const next = draft.kind === "range" ? normalizeRange(draft) : draft;
    const serialized = serializeApplicationsOpenValue(next);
    onChange(serialized);
    committedRef.current = serialized;
    setOpen(false);
  };

  const clearDraft = () => {
    setDraft(emptyApplicationsOpenValue(draft.kind));
    setRangeAnchor(null);
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelectDay = (iso: string) => {
    if (draft.kind === "date") {
      setDraft((prev) => ({ ...prev, date: iso }));
      return;
    }
    if (draft.kind === "range") {
      if (!rangeAnchor || (draft.rangeStart && draft.rangeEnd)) {
        setRangeAnchor(iso);
        setDraft((prev) => ({ ...prev, rangeStart: iso, rangeEnd: "" }));
        return;
      }
      setDraft((prev) => ({ ...prev, rangeEnd: iso }));
      setRangeAnchor(null);
    }
  };

  const canApply = canCommitDraft(draft, committedRef.current);
  const awaitingRangeEnd =
    draft.kind === "range" && Boolean(draft.rangeStart) && !draft.rangeEnd;

  return (
    <div ref={containerRef} className={className}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeWithoutSaving() : openPicker())}
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
            aria-label="Applications open"
            className="fixed z-[200] w-[320px] rounded-xl border border-outline-variant/50 bg-surface-container-lowest shadow-lg overflow-hidden"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-3 border-b border-outline-variant/30">
              <p className="text-sm font-medium text-on-surface">Applications open</p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                Text, a date, a range, or a month
              </p>
            </div>

            <div className="p-3">
              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-surface-container-high/80">
                {KIND_OPTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, kind: id }))}
                    className={`flex flex-col items-center gap-0.5 py-1.5 rounded-md text-[10px] font-medium transition-colors ${
                      draft.kind === id
                        ? "bg-surface-container-lowest text-primary shadow-sm"
                        : "text-on-surface-variant hover:text-on-surface"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 pb-4 min-h-[220px]">
              {draft.kind === "text" && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={draft.text}
                    onChange={(e) => setDraft((prev) => ({ ...prev, text: e.target.value }))}
                    placeholder="e.g. Rolling basis, TBD, After coffee chat"
                    className="w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                    autoFocus
                  />
                  <p className="text-[11px] text-on-surface-variant leading-relaxed">
                    Use free text when the window isn&apos;t a specific date.
                  </p>
                </div>
              )}

              {draft.kind === "date" && (
                <CalendarGrid
                  mode="single"
                  viewYear={viewYear}
                  viewMonth={viewMonth}
                  onPrevMonth={prevMonth}
                  onNextMonth={nextMonth}
                  selectedDay={draft.date}
                  onSelectDay={handleSelectDay}
                />
              )}

              {draft.kind === "range" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div
                      className={`rounded-lg border px-2.5 py-2 transition-colors duration-300 ${
                        draft.rangeStart
                          ? "border-primary/40 bg-primary-container/15"
                          : "border-outline-variant/40"
                      }`}
                    >
                      <p className="text-[10px] font-medium text-on-surface-variant uppercase tracking-wide">Start</p>
                      <p className="text-xs text-on-surface mt-0.5 truncate">
                        {draft.rangeStart ? formatApplicationsOpenDisplay(`date:${draft.rangeStart}`) : "—"}
                      </p>
                    </div>
                    <div
                      className={`rounded-lg border px-2.5 py-2 transition-colors duration-300 ${
                        awaitingRangeEnd
                          ? "animate-range-end-prompt border-primary/50"
                          : draft.rangeEnd
                            ? "border-primary/40 bg-primary-container/15"
                            : "border-outline-variant/40"
                      }`}
                    >
                      <p
                        className={`text-[10px] font-medium uppercase tracking-wide transition-colors duration-300 ${
                          awaitingRangeEnd ? "text-primary" : "text-on-surface-variant"
                        }`}
                      >
                        End
                      </p>
                      <p className="text-xs text-on-surface mt-0.5 truncate">
                        {draft.rangeEnd ? formatApplicationsOpenDisplay(`date:${draft.rangeEnd}`) : "—"}
                      </p>
                    </div>
                  </div>
                  <CalendarGrid
                    mode="range"
                    viewYear={viewYear}
                    viewMonth={viewMonth}
                    onPrevMonth={prevMonth}
                    onNextMonth={nextMonth}
                    rangeStart={draft.rangeStart}
                    rangeEnd={draft.rangeEnd}
                    awaitingRangeEnd={awaitingRangeEnd}
                    onSelectDay={handleSelectDay}
                  />
                  <p
                    key={awaitingRangeEnd ? "awaiting-end" : "pick-start"}
                    className={`text-[11px] animate-range-hint-in ${
                      awaitingRangeEnd ? "text-primary font-medium" : "text-on-surface-variant"
                    }`}
                  >
                    {awaitingRangeEnd
                      ? "Now pick an end date on the calendar"
                      : "Tap a start date, then an end date"}
                  </p>
                </div>
              )}

              {draft.kind === "month" && (
                <MonthGrid
                  viewYear={viewYear}
                  onPrevYear={() => setViewYear((y) => y - 1)}
                  onNextYear={() => setViewYear((y) => y + 1)}
                  selectedMonth={draft.month}
                  onSelectMonth={(iso) => setDraft((prev) => ({ ...prev, month: iso }))}
                />
              )}
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-outline-variant/30 bg-surface-container-high/30">
              <Button type="button" variant="text" size="sm" onClick={clearDraft}>
                Clear
              </Button>
              <Button type="button" variant="filled" size="sm" onClick={apply} disabled={!canApply}>
                Done
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
