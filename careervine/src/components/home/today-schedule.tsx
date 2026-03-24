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

      {calendarConnected && events.length === 0 && (
        <div className="rounded-xl bg-surface-container-low p-5 text-center">
          <p className="text-lg text-muted-foreground">Nothing scheduled today</p>
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
                className="rounded-lg px-4 py-3 hover:bg-surface-container-low transition-colors"
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-lg text-muted-foreground tabular-nums w-[80px] shrink-0">
                    {time}
                  </span>
                  <span className="text-xl font-medium text-foreground truncate">
                    {event.title || "Untitled event"}
                  </span>
                </div>
                {event.contact && (
                  <Link
                    href={`/contacts/${event.contact.id}`}
                    className="flex items-center gap-2 mt-2 ml-[76px] group"
                  >
                    <ContactAvatar
                      name={event.contact.name}
                      photoUrl={event.contact.photo_url}
                      className="w-8 h-8 text-xs"
                    />
                    <span className="text-lg text-muted-foreground group-hover:text-foreground transition-colors truncate">
                      {event.contact.name}
                    </span>
                    <span className="text-base text-muted-foreground/70 truncate">
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
