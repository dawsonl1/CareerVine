"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Calendar } from "lucide-react";

export interface ScheduleEvent {
  id: number;
  title: string | null;
  start_at: string;
  end_at: string;
  contact?: {
    id: number;
    name: string;
    photo_url: string | null;
    lastTouchLabel: string;
  };
}

interface TodayScheduleProps {
  events: ScheduleEvent[];
  loading: boolean;
  calendarConnected: boolean;
  /** Height of the left column (action list) in px — used to expand hour range to fill space */
  availableHeight: number;
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
    earliest = Math.min(earliest, start.getHours());
    latest = Math.max(latest, end.getHours() + (end.getMinutes() > 0 ? 1 : 0));
  }

  return [Math.max(0, earliest - 1), Math.min(24, latest + 1)];
}

/**
 * Expand the hour range to fill available space.
 * Alternates adding hours to the bottom then top, respecting bounds:
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

  let addToBottom = true;
  while (end - start < hoursNeeded) {
    if (addToBottom && end < upperBound) {
      end++;
    } else if (!addToBottom && start > lowerBound) {
      start--;
    } else if (end < upperBound) {
      end++;
    } else if (start > lowerBound) {
      start--;
    } else {
      break;
    }
    addToBottom = !addToBottom;
  }

  return [start, end];
}

function formatHour(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

export function TodaySchedule({ events, loading, calendarConnected, availableHeight }: TodayScheduleProps) {
  const [now, setNow] = useState(new Date());

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
      const endFrac = end.getHours() + end.getMinutes() / 60;
      const top = (startFrac - startHour) * HOUR_HEIGHT;
      const height = Math.max((endFrac - startFrac) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);
      const timeLabel = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return { ...event, top, height, timeLabel };
    });
  }, [events, startHour]);

  if (loading) {
    return (
      <div>
        <h3 className="text-[28px] font-medium text-foreground mb-5">Today</h3>
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
      <h3 className="text-[28px] font-medium text-foreground mb-5">Today</h3>

      {!calendarConnected && (
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
        <div className="relative" style={{ height: totalHeight }}>
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
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <div className="flex-1 border-t-2 border-red-500" />
            </div>
          )}

          {/* Event blocks */}
          {positionedEvents.map((event) => (
            <div
              key={event.id}
              className="absolute rounded-lg bg-primary/10 border-l-[3px] border-primary px-3 py-1.5 overflow-hidden group hover:bg-primary/15 transition-colors cursor-default"
              style={{
                top: event.top,
                height: event.height,
                left: LABEL_WIDTH + 4,
                right: 0,
              }}
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
                <Link
                  href={`/contacts/${event.contact.id}`}
                  className="flex items-center gap-1.5 mt-1 hover:text-foreground transition-colors"
                >
                  <ContactAvatar
                    name={event.contact.name}
                    photoUrl={event.contact.photo_url}
                    className="w-5 h-5 text-[10px]"
                  />
                  <span className="text-xs text-muted-foreground truncate">
                    {event.contact.name}
                  </span>
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
