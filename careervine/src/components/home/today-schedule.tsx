"use client";

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
}

export function TodaySchedule({ events, loading, calendarConnected }: TodayScheduleProps) {
  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-medium text-foreground mb-3">Today</h3>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-surface-container-highest animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-lg font-medium text-foreground mb-3">Today</h3>

      {!calendarConnected && (
        <Link
          href="/settings?tab=integrations"
          className="block rounded-xl border border-dashed border-outline-variant p-4 text-center hover:bg-surface-container-low transition-colors"
        >
          <Calendar className="h-5 w-5 text-muted-foreground mx-auto mb-1.5" />
          <p className="text-xs text-muted-foreground">
            Connect Google Calendar to see your schedule
          </p>
        </Link>
      )}

      {calendarConnected && events.length === 0 && (
        <div className="rounded-xl bg-surface-container-low p-4 text-center">
          <p className="text-xs text-muted-foreground">Nothing scheduled today</p>
        </div>
      )}

      {calendarConnected && events.length > 0 && (
        <div className="space-y-1">
          {events.map((event) => {
            const time = new Date(event.start_at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            });
            return (
              <div
                key={event.id}
                className="rounded-lg px-3 py-2.5 hover:bg-surface-container-low transition-colors"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums w-14 shrink-0">
                    {time}
                  </span>
                  <span className="text-sm font-medium text-foreground truncate">
                    {event.title || "Untitled event"}
                  </span>
                </div>
                {event.contact && (
                  <Link
                    href={`/contacts/${event.contact.id}`}
                    className="flex items-center gap-2 mt-1.5 ml-14 group"
                  >
                    <ContactAvatar
                      name={event.contact.name}
                      photoUrl={event.contact.photo_url}
                      className="w-5 h-5 text-[8px]"
                    />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors truncate">
                      {event.contact.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70 truncate">
                      {event.contact.lastTouchLabel}
                    </span>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
