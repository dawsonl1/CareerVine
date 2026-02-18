/**
 * Calendar page — view and manage Google Calendar events
 *
 * Features:
 * - List view of events for the next 14 days
 * - RSVP status badges for attendees
 * - Private event masking (shows "Busy" with lock icon)
 * - Recurring event indicators
 * - Auto-sync on page load with manual sync button
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, Lock, RotateCcw, Video, MapPin, Users } from "lucide-react";

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
            <p className="text-sm text-muted-foreground mt-1">Your schedule for the next 14 days</p>
          </div>
          <Button onClick={handleSync} loading={syncing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            Sync
          </Button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            {error}
          </div>
        )}

        {events.length === 0 ? (
          <Card variant="outlined">
            <CardContent className="p-12 text-center">
              <div className="text-muted-foreground">
                <p className="text-sm mb-2">No events scheduled</p>
                <p className="text-xs">Your calendar is empty for the next 14 days</p>
              </div>
            </CardContent>
          </Card>
        ) : (
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
        )}
      </main>
    </div>
  );
}
