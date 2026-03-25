"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Calendar, MapPin, Video, Clock, Users, X } from "lucide-react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";

export interface ScheduleEventAttendee {
  email: string;
  name?: string;
  responseStatus?: string;
}

export interface ScheduleEvent {
  id: number;
  title: string | null;
  start_at: string;
  end_at: string;
  description: string | null;
  location: string | null;
  meet_link: string | null;
  attendees: ScheduleEventAttendee[];
  /** Resolved contact (from attendee matching or contact_id lookup) */
  contact?: {
    id: number;
    name: string;
    photo_url: string | null;
    lastTouchLabel: string;
  };
  /** Raw contact_id from the calendar event — fallback when contact object isn't resolved */
  contact_id?: number | null;
}

export interface LogConversationEvent {
  contactId?: number;
  title?: string;
  startAt?: string;
  endAt?: string;
  meetLink?: string | null;
}

interface TodayScheduleProps {
  events: ScheduleEvent[];
  loading: boolean;
  calendarConnected: boolean;
  /** Height of the left column (action list) in px — used to expand hour range to fill space */
  availableHeight: number;
  onLogConversation?: (event: LogConversationEvent) => void;
  onEventCreated?: () => void;
}

// ── Drag-to-create types ──

interface DragState {
  startY: number;
  currentY: number;
  isDragging: boolean;
}

interface NewEventDraft {
  startHour: number;
  endHour: number;
  top: number;
  height: number;
}

const SNAP_MINUTES = 15; // Snap to 15-minute intervals

function snapToInterval(hourFrac: number): number {
  const totalMinutes = hourFrac * 60;
  const snapped = Math.round(totalMinutes / SNAP_MINUTES) * SNAP_MINUTES;
  return snapped / 60;
}

function formatTime(hourFrac: number): string {
  const hours = Math.floor(hourFrac);
  const minutes = Math.round((hourFrac - hours) * 60);
  if (hours === 0 || hours === 24) return `12:${String(minutes).padStart(2, "0")} AM`;
  const period = hours >= 12 ? "PM" : "AM";
  const h = hours > 12 ? hours - 12 : hours;
  return `${h}:${String(minutes).padStart(2, "0")} ${period}`;
}

const HOUR_HEIGHT = 52; // px per hour
const MIN_EVENT_HEIGHT = 28; // minimum event block height
const LABEL_WIDTH = 48; // width for hour labels
const TITLE_HEIGHT = 48; // approximate height of the "Today" heading + margin
const MAX_LATE_HOUR = 22; // don't show past 10 PM unless events exist later
const MIN_EARLY_HOUR = 7; // don't show before 7 AM unless events exist earlier

/**
 * Compute the minimum hour range needed to show all events.
 * 1 hour padding before earliest event, 1 hour after latest.
 * If no events, center around current hour with a small window.
 */
function getMinHourRange(events: ScheduleEvent[]): [number, number] {
  if (events.length === 0) {
    const currentHour = new Date().getHours();
    return [Math.max(0, currentHour - 1), Math.min(24, currentHour + 4)];
  }

  let earliest = 24;
  let latest = 0;

  for (const e of events) {
    const start = new Date(e.start_at);
    const end = new Date(e.end_at);
    const startHr = start.getHours();
    let endHr = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
    // If event ends past midnight, clamp to 24 so the grid extends to cover it
    if (endHr <= startHr) endHr = 24;
    earliest = Math.min(earliest, startHr);
    latest = Math.max(latest, endHr);
  }

  return [Math.max(0, earliest - 1), Math.min(24, latest + 1)];
}

/**
 * Expand the hour range to fill available space.
 * Extends toward evening (10 PM) first, then toward morning (7 AM).
 * - Won't go past MAX_LATE_HOUR (10 PM) unless events already push past it
 * - Won't go before MIN_EARLY_HOUR (7 AM) unless events already push before it
 */
function expandHourRange(
  minStart: number,
  minEnd: number,
  availableHeight: number
): [number, number] {
  const hoursNeeded = Math.ceil(availableHeight / HOUR_HEIGHT);
  let start = minStart;
  let end = minEnd;

  const lowerBound = Math.min(MIN_EARLY_HOUR, minStart);
  const upperBound = Math.max(MAX_LATE_HOUR, minEnd);

  // Phase 1: extend toward evening first
  while (end - start < hoursNeeded && end < upperBound) {
    end++;
  }

  // Phase 2: extend toward morning if still need more space
  while (end - start < hoursNeeded && start > lowerBound) {
    start--;
  }

  return [start, end];
}

function formatHour(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function formatTimeRange(startAt: string, endAt: string): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

// ── Event Detail Popover ──

function EventPopover({
  event,
  onClose,
  onLogConversation,
}: {
  event: ScheduleEvent & { top: number; height: number; timeLabel: string };
  onClose: () => void;
  onLogConversation?: (event: LogConversationEvent) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the click that opened it from immediately closing it
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const meetingLink = event.meet_link;
  const attendees = (event.attendees || []).filter((a) => a.email);

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant w-[300px] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{
        // Position to the left of the event block, or overlay if not enough room
        right: "calc(100% + 8px)",
        top: Math.max(0, event.top - 20),
      }}
    >
      {/* Action bar */}
      <div className="flex items-center justify-end gap-1 px-3 pt-3 pb-1">
        {onLogConversation && (
          <button
            type="button"
            onClick={() => { onLogConversation({ contactId: event.contact?.id ?? event.contact_id ?? undefined, title: event.title ?? undefined, startAt: event.start_at, endAt: event.end_at, meetLink: event.meet_link }); onClose(); }}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
            title="Log conversation"
          >
            <Calendar className="h-4 w-4" />
          </button>
        )}
        {meetingLink && (
          <a
            href={meetingLink}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors"
            title="Join meeting"
          >
            <Video className="h-4 w-4" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Event details */}
      <div className="px-4 pb-4">
        {/* Title */}
        <div className="flex items-start gap-2.5 mb-2">
          <div className="w-3 h-3 rounded-sm bg-primary mt-1.5 shrink-0" />
          <div>
            <p className="text-base font-medium text-foreground leading-snug">
              {event.title || "Untitled event"}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatDate(event.start_at)} · {formatTimeRange(event.start_at, event.end_at)}
            </p>
          </div>
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-start gap-2.5 mt-3">
            <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">{event.location}</p>
          </div>
        )}

        {/* Meeting link */}
        {meetingLink && (
          <div className="flex items-start gap-2.5 mt-2">
            <Video className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <a
              href={meetingLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline truncate"
            >
              Join Google Meet
            </a>
          </div>
        )}

        {/* Attendees */}
        {attendees.length > 0 && (
          <div className="flex items-start gap-2.5 mt-3">
            <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              {attendees.slice(0, 5).map((a, i) => (
                <p key={i} className="text-sm text-muted-foreground truncate">
                  {a.name || a.email}
                  {a.responseStatus === "declined" && (
                    <span className="text-xs text-destructive ml-1.5">declined</span>
                  )}
                  {a.responseStatus === "tentative" && (
                    <span className="text-xs text-muted-foreground ml-1.5">maybe</span>
                  )}
                </p>
              ))}
              {attendees.length > 5 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  +{attendees.length - 5} more
                </p>
              )}
            </div>
          </div>
        )}

        {/* Description */}
        {event.description && (
          <div className="mt-3 pt-3 border-t border-outline-variant/50">
            <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
              {event.description}
            </p>
          </div>
        )}

        {/* Contact context */}
        {event.contact && (
          <div className="mt-3 pt-3 border-t border-outline-variant/50">
            <Link
              href={`/contacts/${event.contact.id}`}
              className="flex items-center gap-2 hover:bg-surface-container-low rounded-lg p-1.5 -mx-1.5 transition-colors"
            >
              <ContactAvatar
                name={event.contact.name}
                photoUrl={event.contact.photo_url}
                className="w-7 h-7 text-xs"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{event.contact.name}</p>
                <p className="text-xs text-muted-foreground">{event.contact.lastTouchLabel}</p>
              </div>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quick-add event card ──

function QuickAddCard({
  draft,
  onSave,
  onCancel,
}: {
  draft: NewEventDraft;
  onSave: (title: string, addMeet: boolean) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [addMeet, setAddMeet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [onCancel]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(title || "(No title)", addMeet);
    } catch {
      setError("Failed to create event");
      setSaving(false);
    }
  };

  return (
    <div
      ref={cardRef}
      className="absolute z-50 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant w-[280px] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{
        right: "calc(100% + 8px)",
        top: 0,
      }}
    >
      <div className="p-4">
        {/* Title input */}
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="Add title"
          className="w-full text-lg font-medium text-foreground bg-transparent border-b-2 border-primary pb-2 placeholder:text-muted-foreground/50 focus:outline-none"
        />

        {/* Time range */}
        <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
          <Clock className="h-4 w-4 shrink-0" />
          <span>{formatTime(draft.startHour)} – {formatTime(draft.endHour)}</span>
        </div>

        {/* Google Meet toggle */}
        <label className="flex items-center gap-2 mt-2.5 text-sm text-muted-foreground cursor-pointer">
          <Video className="h-4 w-4 shrink-0" />
          <span className="flex-1">Add Google Meet</span>
          <input
            type="checkbox"
            checked={addMeet}
            onChange={(e) => setAddMeet(e.target.checked)}
            className="w-4 h-4 accent-primary cursor-pointer"
          />
        </label>
      </div>

      {error && <p className="text-xs text-destructive px-4 pb-1">{error}</p>}
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-full"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Main component ──

export function TodaySchedule({ events, loading, calendarConnected, availableHeight, onLogConversation, onEventCreated }: TodayScheduleProps) {
  const { advanceIfStep } = useOnboarding();
  const [now, setNow] = useState(new Date());
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  // Drag-to-create state
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [newEventDraft, setNewEventDraft] = useState<NewEventDraft | null>(null);

  // Update "now" every minute for the current-time indicator
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const [minStart, minEnd] = useMemo(() => getMinHourRange(events), [events]);

  // Available height for the grid = left column height minus the title area
  const gridAvailable = Math.max(0, availableHeight - TITLE_HEIGHT);

  const [startHour, endHour] = useMemo(
    () => expandHourRange(minStart, minEnd, gridAvailable),
    [minStart, minEnd, gridAvailable]
  );

  const totalHeight = (endHour - startHour) * HOUR_HEIGHT;

  // Current time position
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const showNowLine = nowHour >= startHour && nowHour <= endHour;
  const nowTop = (nowHour - startHour) * HOUR_HEIGHT;

  // Position events
  const positionedEvents = useMemo(() => {
    return events.map((event) => {
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      const startFrac = start.getHours() + start.getMinutes() / 60;
      let endFrac = end.getHours() + end.getMinutes() / 60;
      // Clamp midnight-spanning events to end of grid
      if (endFrac <= startFrac) endFrac = 24;
      const top = (startFrac - startHour) * HOUR_HEIGHT;
      const height = Math.max((endFrac - startFrac) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);
      const timeLabel = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return { ...event, top, height, timeLabel };
    });
  }, [events, startHour]);

  // ── Drag-to-create handlers ──

  const yToHour = useCallback((y: number): number => {
    if (!gridRef.current) return startHour;
    const rect = gridRef.current.getBoundingClientRect();
    const relativeY = y - rect.top;
    const raw = snapToInterval(startHour + relativeY / HOUR_HEIGHT);
    return Math.max(startHour, Math.min(endHour, raw));
  }, [startHour, endHour]);

  const handleGridMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start drag on the grid background, not on events or popovers
    const target = e.target as HTMLElement;
    if (target.closest("[data-event-block]") || target.closest("[data-popover]")) return;
    if (newEventDraft) { setNewEventDraft(null); return; } // Close any open draft

    e.preventDefault(); // Prevent browser text-selection / drag that scrolls the page
    setSelectedEventId(null);
    setDragState({ startY: e.clientY, currentY: e.clientY, isDragging: false });
  }, [newEventDraft]);

  const handleGridMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState) return;
    const dy = Math.abs(e.clientY - dragState.startY);
    if (dy > 4) {
      setDragState({ ...dragState, currentY: e.clientY, isDragging: true });
    }
  }, [dragState]);

  const handleGridMouseUp = useCallback((e: React.MouseEvent) => {
    if (!dragState) return;

    if (dragState.isDragging) {
      const h1 = yToHour(dragState.startY);
      const h2 = yToHour(e.clientY);
      const draftStart = Math.min(h1, h2);
      const draftEnd = Math.max(h1, h2);
      // Minimum 15 minutes
      const finalEnd = draftEnd - draftStart < 0.25 ? draftStart + 0.25 : draftEnd;

      const top = (draftStart - startHour) * HOUR_HEIGHT;
      const height = (finalEnd - draftStart) * HOUR_HEIGHT;

      setNewEventDraft({ startHour: draftStart, endHour: finalEnd, top, height });
    }

    setDragState(null);
  }, [dragState, yToHour, startHour]);

  // Drag preview dimensions
  const dragPreview = useMemo(() => {
    if (!dragState?.isDragging) return null;
    const h1 = yToHour(dragState.startY);
    const h2 = yToHour(dragState.currentY);
    const s = Math.min(h1, h2);
    const e = Math.max(h1, h2);
    const finalEnd = e - s < 0.25 ? s + 0.25 : e;
    return {
      top: (s - startHour) * HOUR_HEIGHT,
      height: (finalEnd - s) * HOUR_HEIGHT,
      label: `${formatTime(s)} – ${formatTime(finalEnd)}`,
    };
  }, [dragState, yToHour, startHour]);

  const handleSaveNewEvent = useCallback(async (title: string, addMeet: boolean) => {
    if (!newEventDraft) return;
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startMs = startDate.getTime() + newEventDraft.startHour * 60 * 60 * 1000;
    const endMs = startDate.getTime() + newEventDraft.endHour * 60 * 60 * 1000;

    const res = await fetch("/api/calendar/create-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: title,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        conferenceType: addMeet ? "meet" : "none",
      }),
    });
    if (!res.ok) throw new Error("Failed to create event");
    setNewEventDraft(null);
    onEventCreated?.();
  }, [newEventDraft, onEventCreated]);

  if (loading) {
    return (
      <div>
        <h3 className="text-[28px] font-medium text-foreground mb-8">Today</h3>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-container-highest animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-[28px] font-medium text-foreground mb-8">Today</h3>

      {!calendarConnected && !loading && (
        <Link
          href="/settings?tab=integrations"
          className="block rounded-xl border border-dashed border-outline-variant p-5 text-center hover:bg-surface-container-low transition-colors"
        >
          <Calendar className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-lg text-muted-foreground">
            Connect Google Calendar to see your schedule
          </p>
        </Link>
      )}

      {calendarConnected && (
        <div
          ref={gridRef}
          className="relative select-none"
          style={{ height: totalHeight, cursor: dragState?.isDragging ? "ns-resize" : undefined }}
          onMouseDown={handleGridMouseDown}
          onMouseMove={handleGridMouseMove}
          onMouseUp={handleGridMouseUp}
          onMouseLeave={() => { if (dragState) setDragState(null); }}
        >
          {/* Hour grid lines + labels */}
          {Array.from({ length: endHour - startHour + 1 }, (_, i) => {
            const hour = startHour + i;
            const top = i * HOUR_HEIGHT;
            return (
              <div key={hour} className="absolute left-0 right-0" style={{ top }}>
                <div className="flex items-start">
                  <span
                    className="text-xs text-muted-foreground/60 tabular-nums shrink-0 -translate-y-1/2"
                    style={{ width: LABEL_WIDTH }}
                  >
                    {hour < 24 ? formatHour(hour) : ""}
                  </span>
                  <div className="flex-1 border-t border-outline-variant/30" />
                </div>
              </div>
            );
          })}

          {/* Current time indicator */}
          {showNowLine && (
            <div
              className="absolute right-0 z-20 flex items-center"
              style={{ top: nowTop, left: LABEL_WIDTH - 4 }}
            >
              <div className="w-2 h-2 rounded-full bg-destructive" />
              <div className="flex-1 border-t-2 border-destructive" />
            </div>
          )}

          {/* Event blocks */}
          {positionedEvents.map((event) => (
            <div key={event.id} data-event-block className="absolute" style={{ top: event.top, height: event.height, left: LABEL_WIDTH + 4, right: 0 }} {...(event.title?.includes("Dawson Pitcher") ? { "data-onboarding-target": "onboarding-meeting" } : {})}>
              <div
                onClick={() => {
                  setSelectedEventId(selectedEventId === event.id ? null : event.id);
                  if (event.title?.includes("Dawson Pitcher")) {
                    advanceIfStep("click_meeting");
                  }
                }}
                className={`h-full rounded-lg border-l-[3px] border-primary px-3 py-1.5 overflow-hidden transition-colors cursor-pointer ${
                  selectedEventId === event.id ? "bg-primary/20" : "bg-primary/10 hover:bg-primary/15"
                }`}
              >
                <p className="text-sm font-medium text-foreground truncate leading-tight">
                  {event.title || "Untitled event"}
                </p>
                {event.height >= 40 && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {event.timeLabel}
                  </p>
                )}
                {event.contact && event.height >= 56 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <ContactAvatar
                      name={event.contact.name}
                      photoUrl={event.contact.photo_url}
                      className="w-5 h-5 text-[10px]"
                    />
                    <span className="text-xs text-muted-foreground truncate">
                      {event.contact.name}
                    </span>
                  </div>
                )}
              </div>

              {/* Event detail popover */}
              {selectedEventId === event.id && (
                <EventPopover
                  event={event}
                  onClose={() => setSelectedEventId(null)}
                  onLogConversation={onLogConversation}
                />
              )}
            </div>
          ))}

          {/* Drag preview */}
          {dragPreview && (
            <div
              className="absolute rounded-lg bg-primary/20 border-2 border-dashed border-primary/50 px-3 py-1.5 pointer-events-none"
              style={{
                top: dragPreview.top,
                height: dragPreview.height,
                left: LABEL_WIDTH + 4,
                right: 0,
              }}
            >
              <p className="text-xs font-medium text-primary">{dragPreview.label}</p>
            </div>
          )}

          {/* New event draft + quick-add card */}
          {newEventDraft && (
            <div
              className="absolute"
              style={{
                top: newEventDraft.top,
                height: newEventDraft.height,
                left: LABEL_WIDTH + 4,
                right: 0,
              }}
            >
              <div className="h-full rounded-lg bg-primary/15 border-l-[3px] border-primary px-3 py-1.5">
                <p className="text-xs font-medium text-primary">(No title)</p>
                <p className="text-xs text-primary/70">
                  {formatTime(newEventDraft.startHour)} – {formatTime(newEventDraft.endHour)}
                </p>
              </div>
              <QuickAddCard
                draft={newEventDraft}
                onSave={handleSaveNewEvent}
                onCancel={() => setNewEventDraft(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
