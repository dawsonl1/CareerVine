/**
 * Calendar page — view and manage Google Calendar events
 *
 * Features:
 * - List view of events for the next 14 days
 * - Week grid view (Mon–Sun) with hourly time slots
 * - RSVP status badges for attendees
 * - Private event masking (shows "Busy" with lock icon)
 * - Recurring event indicators
 * - Auto-sync on page load with manual sync button
 */

"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, Lock, RotateCcw, Video, MapPin, Users, List, LayoutGrid, ChevronLeft, ChevronRight } from "lucide-react";

// Day grid parameters: 7am–10pm = 15 hours
const GRID_START_HOUR = 7;
const GRID_END_HOUR = 22;
const GRID_HOURS = GRID_END_HOUR - GRID_START_HOUR;
const HOUR_HEIGHT = 56; // px per hour

interface CalendarEvent {
  id: number;
  title: string | null;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  meet_link: string | null;
  is_private: boolean;
  recurring_event_id: string | null;
  attendees: Array<{ email: string; name: string; responseStatus: string }>;
}

export default function CalendarPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "week">("list");
  const [weekOffset, setWeekOffset] = useState(0); // weeks from current

  // Compute the Mon-Sun of the displayed week
  const weekDays = useMemo(() => {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1; // 0=Mon
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeek + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [weekOffset]);

  const weekEvents = useMemo(() => {
    const start = weekDays[0];
    const end = new Date(weekDays[6]);
    end.setHours(23, 59, 59, 999);
    return events.filter(e => {
      const s = new Date(e.start_at);
      return s >= start && s <= end;
    });
  }, [events, weekDays]);

  useEffect(() => {
    if (user) {
      loadEvents();
    }
  }, [user]);

  const loadEvents = async () => {
    if (!user) return;
    try {
      setLoading(true);
      const res = await fetch("/api/calendar/events");
      const data = await res.json();
      if (data.events) {
        setEvents(data.events.sort((a: CalendarEvent, b: CalendarEvent) => 
          new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
        ));
      }
    } catch (err) {
      console.error("Error loading events:", err);
      setError("Failed to load calendar events");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      const res = await fetch("/api/calendar/sync", { method: "POST" });
      if (res.status === 429) {
        setError("Synced recently, try again in a moment");
        return;
      }
      if (!res.ok) throw new Error("Sync failed");
      await loadEvents();
      setError("");
    } catch (err) {
      console.error("Sync error:", err);
      setError("Failed to sync calendar");
    } finally {
      setSyncing(false);
    }
  };

  const formatHour = (h: number) => {
    if (h === 0) return "12 AM";
    if (h < 12) return `${h} AM`;
    if (h === 12) return "12 PM";
    return `${h - 12} PM`;
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading calendar…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Calendar</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {view === "week"
                ? `${weekDays[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : "Your schedule for the next 14 days"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {view === "week" && (
              <div className="flex items-center gap-1">
                <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 rounded-full hover:bg-surface-container-low transition-colors text-muted-foreground hover:text-foreground">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button onClick={() => setWeekOffset(0)} className="px-2 py-1 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors">
                  Today
                </button>
                <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 rounded-full hover:bg-surface-container-low transition-colors text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="flex rounded-full border border-outline-variant overflow-hidden">
              <button
                onClick={() => setView("list")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                  view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                }`}
              >
                <List className="h-3.5 w-3.5" /> List
              </button>
              <button
                onClick={() => setView("week")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                  view === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" /> Week
              </button>
            </div>
            <Button onClick={handleSync} loading={syncing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
              Sync
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ── Week Grid View ── */}
        {view === "week" && (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Day headers */}
              <div className="grid grid-cols-[48px_repeat(7,1fr)] mb-1">
                <div /> {/* time gutter */}
                {weekDays.map((day, i) => {
                  const isToday = day.toDateString() === new Date().toDateString();
                  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
                  return (
                    <div key={i} className="text-center pb-2 border-b border-outline-variant/50">
                      <p className="text-[11px] text-muted-foreground">{dayNames[i]}</p>
                      <div className={`inline-flex items-center justify-center w-7 h-7 rounded-full mx-auto mt-0.5 ${isToday ? "bg-primary text-primary-foreground" : "text-foreground"}`}>
                        <span className="text-sm font-medium">{day.getDate()}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* All-day row */}
              {weekEvents.some(e => e.all_day) && (
                <div className="grid grid-cols-[48px_repeat(7,1fr)] mb-1 border-b border-outline-variant/50">
                  <div className="text-[10px] text-muted-foreground text-right pr-2 pt-1">all day</div>
                  {weekDays.map((day, i) => {
                    const dayAllDay = weekEvents.filter(e => {
                      if (!e.all_day) return false;
                      const s = new Date(e.start_at);
                      return s.toDateString() === day.toDateString();
                    });
                    return (
                      <div key={i} className="px-0.5 py-0.5 min-h-[24px]">
                        {dayAllDay.map(e => (
                          <div key={e.id} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary truncate">
                            {e.is_private ? "Busy" : (e.title || "Untitled")}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Time grid */}
              <div className="grid grid-cols-[48px_repeat(7,1fr)] relative" style={{ height: `${GRID_HOURS * HOUR_HEIGHT}px` }}>
                {/* Hour lines + labels */}
                {Array.from({ length: GRID_HOURS }, (_, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 border-t border-outline-variant/30 flex items-start"
                    style={{ top: `${i * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
                  >
                    <span className="text-[10px] text-muted-foreground w-[44px] text-right pr-2 -mt-[6px] select-none">
                      {formatHour(GRID_START_HOUR + i)}
                    </span>
                  </div>
                ))}

                {/* Day columns */}
                {weekDays.map((day, colIdx) => {
                  const isToday = day.toDateString() === new Date().toDateString();
                  const dayEvents = weekEvents.filter(e => {
                    if (e.all_day) return false;
                    const s = new Date(e.start_at);
                    return s.toDateString() === day.toDateString();
                  });

                  return (
                    <div
                      key={colIdx}
                      className={`absolute border-l border-outline-variant/30 ${isToday ? "bg-primary/[0.02]" : ""}`}
                      style={{
                        left: `calc(48px + (100% - 48px) * ${colIdx} / 7)`,
                        width: `calc((100% - 48px) / 7)`,
                        top: 0,
                        height: "100%",
                      }}
                    >
                      {dayEvents.map(event => {
                        const start = new Date(event.start_at);
                        const end = new Date(event.end_at);
                        const startMins = (start.getHours() - GRID_START_HOUR) * 60 + start.getMinutes();
                        const endMins = (end.getHours() - GRID_START_HOUR) * 60 + end.getMinutes();
                        const clampedStart = Math.max(0, startMins);
                        const clampedEnd = Math.min(GRID_HOURS * 60, endMins);
                        const top = (clampedStart / 60) * HOUR_HEIGHT;
                        const height = Math.max(18, ((clampedEnd - clampedStart) / 60) * HOUR_HEIGHT - 2);

                        return (
                          <div
                            key={event.id}
                            className={`absolute left-0.5 right-0.5 rounded px-1 py-0.5 overflow-hidden text-[10px] leading-tight ${
                              event.is_private
                                ? "bg-surface-container text-muted-foreground border border-outline-variant/50"
                                : "bg-primary/15 text-primary border border-primary/20"
                            }`}
                            style={{ top: `${top}px`, height: `${height}px` }}
                            title={event.is_private ? "Private event" : (event.title || "Untitled")}
                          >
                            {event.is_private ? (
                              <span className="flex items-center gap-0.5"><Lock className="h-2.5 w-2.5 shrink-0" /> Busy</span>
                            ) : (
                              <>
                                <div className="font-medium truncate">{event.title || "Untitled"}</div>
                                {height > 32 && (
                                  <div className="truncate text-primary/70">
                                    {start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                                    {event.recurring_event_id && " ↻"}
                                    {event.meet_link && " 🎥"}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {weekOffset === 0 && (() => {
                  const now = new Date();
                  const todayMins = (now.getHours() - GRID_START_HOUR) * 60 + now.getMinutes();
                  if (todayMins < 0 || todayMins > GRID_HOURS * 60) return null;
                  const todayColIdx = weekDays.findIndex(d => d.toDateString() === now.toDateString());
                  if (todayColIdx < 0) return null;
                  return (
                    <div
                      className="absolute h-0.5 bg-primary/70 z-10 pointer-events-none"
                      style={{
                        top: `${(todayMins / 60) * HOUR_HEIGHT}px`,
                        left: `calc(48px + (100% - 48px) * ${todayColIdx} / 7)`,
                        width: `calc((100% - 48px) / 7)`,
                      }}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── List View ── */}
        {view === "list" && events.length === 0 ? (
          <Card variant="outlined">
            <CardContent className="p-12 text-center">
              <div className="text-muted-foreground">
                <p className="text-sm mb-2">No events scheduled</p>
                <p className="text-xs">Your calendar is empty for the next 14 days</p>
              </div>
            </CardContent>
          </Card>
        ) : view === "list" ? (
          <div className="space-y-4">
            {events.map((event) => {
              const startDate = new Date(event.start_at);
              const endDate = new Date(event.end_at);
              const isToday = startDate.toDateString() === new Date().toDateString();
              const dateStr = startDate.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              });
              const timeStr = startDate.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              });
              const endTimeStr = endDate.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              });

              return (
                <Card key={event.id} variant="outlined">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0 w-16 text-center">
                        <p className="text-xs font-medium text-muted-foreground">{dateStr}</p>
                        <p className={`text-sm font-semibold ${isToday ? "text-primary" : "text-foreground"}`}>
                          {startDate.getDate()}
                        </p>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            {event.is_private ? (
                              <div className="flex items-center gap-2">
                                <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                <p className="text-sm font-medium text-muted-foreground">Private event</p>
                              </div>
                            ) : (
                              <>
                                <h3 className="text-sm font-medium text-foreground truncate">{event.title || "Untitled"}</h3>
                                {event.description && (
                                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{event.description}</p>
                                )}
                              </>
                            )}
                          </div>
                          {event.recurring_event_id && (
                            <div title="Recurring event">
                              <RotateCcw className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mb-3">
                          <span>
                            {event.all_day ? "All day" : `${timeStr} – ${endTimeStr}`}
                          </span>
                          {event.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {event.location}
                            </span>
                          )}
                        </div>

                        {event.meet_link && (
                          <a
                            href={event.meet_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors mb-3"
                          >
                            <Video className="h-3 w-3" />
                            Join meeting
                          </a>
                        )}

                        {!event.is_private && event.attendees.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-outline-variant/50">
                            <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              Attendees
                            </p>
                            <div className="space-y-1">
                              {event.attendees.map((attendee, idx) => {
                                const statusColor = {
                                  accepted: "text-primary",
                                  declined: "text-destructive",
                                  tentative: "text-yellow-600",
                                  needsAction: "text-muted-foreground",
                                }[attendee.responseStatus] || "text-muted-foreground";

                                const statusLabel = {
                                  accepted: "✓",
                                  declined: "✗",
                                  tentative: "?",
                                  needsAction: "–",
                                }[attendee.responseStatus] || "–";

                                return (
                                  <div key={idx} className="flex items-center gap-2 text-xs">
                                    <span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
                                    <span className="text-foreground">{attendee.name || attendee.email}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : null}
      </main>
    </div>
  );
}
