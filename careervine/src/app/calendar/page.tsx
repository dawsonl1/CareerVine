"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { Select } from "@/components/ui/select";
import { getMeetings, createMeeting, updateMeeting, getContacts, addContactsToMeeting, replaceContactsForMeeting } from "@/lib/queries";
import type { Meeting, SimpleContact } from "@/lib/types";
import { RefreshCw, Lock, RotateCcw, Video, MapPin, List, LayoutGrid, ChevronLeft, ChevronRight, Pencil, X, Plus, Search } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { Toggle } from "@/components/ui/toggle";
import { useToast } from "@/components/ui/toast";
import { CONVERSATION_TYPE_OPTIONS, getRsvpDisplay } from "@/lib/constants";

// Day grid parameters: 7am–10pm = 15 hours
const GRID_START_HOUR = 7;
const GRID_END_HOUR = 22;
const GRID_HOURS = GRID_END_HOUR - GRID_START_HOUR;
const HOUR_HEIGHT = 56; // px per hour

interface CalendarEvent {
  id: number;
  google_event_id: string;
  title: string | null;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  meet_link: string | null;
  is_private: boolean;
  recurring_event_id: string | null;
  contact_id: number | null;
  attendees: Array<{ email: string; name: string; responseStatus: string }>;
}

type ContactFilter = "all" | "contacts" | "no-contacts";

const emptyForm = { meeting_date: "", meeting_time: "", meeting_type: "", title: "", notes: "", privateNotes: "", calendarDescription: "", transcript: "" };

function minsToTimeStr(totalMins: number) {
  const h = GRID_START_HOUR + Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function dateToStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function snapMins(raw: number) { return Math.round(raw / 15) * 15; }

export default function CalendarPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  // ── Core
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "week">("list");
  const [weekOffset, setWeekOffset] = useState(0);
  const [contactFilter, setContactFilter] = useState<ContactFilter>("all");

  // ── Contacts + linked meetings
  const [allContacts, setAllContacts] = useState<SimpleContact[]>([]);
  const [contactEmailsMap, setContactEmailsMap] = useState<Record<number, string[]>>({});
  const [linkedMeetings, setLinkedMeetings] = useState<Record<string, Meeting>>({});

  // ── Week view: event bubble
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [bubblePos, setBubblePos] = useState({ top: 0, left: 0, alignRight: false });

  // ── Week view: drag-to-create
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{ day: Date; startMins: number; currentMins: number } | null>(null);

  // ── Meeting form
  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [inviteEmailMap, setInviteEmailMap] = useState<Record<number, string>>({});
  const [includeMeetLink, setIncludeMeetLink] = useState(true);
  const [meetingDuration, setMeetingDuration] = useState(60);
  const [calendarConnected, setCalendarConnected] = useState(false);

  // ── Derived: week days Mon–Sun
  const weekDays = useMemo(() => {
    const today = new Date();
    const dow = today.getDay() === 0 ? 6 : today.getDay() - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - dow + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  }, [weekOffset]);

  const weekLabel = useMemo(() => {
    if (weekOffset === 0) return "This Week";
    if (weekOffset === 1) return "Next Week";
    if (weekOffset === -1) return "Last Week";
    if (weekOffset > 1) return `In ${weekOffset} Weeks`;
    return `${Math.abs(weekOffset)} Weeks Ago`;
  }, [weekOffset]);

  const isFutureMeeting = (() => {
    if (!formData.meeting_date) return false;
    const dt = formData.meeting_time ? new Date(`${formData.meeting_date}T${formData.meeting_time}`) : new Date(`${formData.meeting_date}T23:59`);
    return dt > new Date();
  })();

  // Map email → contact name, and set of all known contact emails
  const contactEmailToName = useMemo(() => {
    const map: Record<string, string> = {};
    allContacts.forEach(c => {
      const emails = contactEmailsMap[c.id] || (c.email ? [c.email] : []);
      emails.forEach(email => { if (email) map[email.toLowerCase()] = c.name; });
    });
    return map;
  }, [allContacts, contactEmailsMap]);

  const eventHasContact = (e: CalendarEvent) =>
    e.contact_id !== null ||
    e.attendees.some(a => contactEmailToName[a.email?.toLowerCase()] !== undefined);

  const filteredEvents = useMemo(() => events.filter(e => {
    if (contactFilter === "contacts") return eventHasContact(e);
    if (contactFilter === "no-contacts") return !eventHasContact(e);
    return true;
  }), [events, contactFilter, contactEmailToName]);

  const weekEvents = useMemo(() => {
    const startStr = dateToStr(weekDays[0]);
    const endStr = dateToStr(weekDays[6]);
    const start = weekDays[0];
    const end = new Date(weekDays[6]); end.setHours(23, 59, 59, 999);
    return filteredEvents.filter(e => {
      if (e.all_day) {
        // All-day events are stored as UTC midnight — compare date strings to avoid timezone shift
        const d = e.start_at.slice(0, 10);
        return d >= startStr && d <= endStr;
      }
      const s = new Date(e.start_at);
      return s >= start && s <= end;
    });
  }, [filteredEvents, weekDays]);

  // ── Mount
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadEvents(), loadContacts(), loadLinkedMeetings(), checkCalendarConnection()]);
      // Background auto-sync (silent, respects 5-min cooldown)
      fetch("/api/calendar/sync", { method: "POST" }).then(r => { if (r.ok) loadEvents(); }).catch(() => {});
    } finally { setLoading(false); }
  }, [user]);

  useEffect(() => { if (user) loadData(); }, [user, loadData]);

  const loadEvents = async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const data = await res.json();
    if (data.events) setEvents(data.events.sort((a: CalendarEvent, b: CalendarEvent) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()));
  };

  const loadContacts = async () => {
    if (!user) return;
    const data = await getContacts(user.id);
    const em: Record<number, string[]> = {};
    setAllContacts((data as any[]).map(c => {
      const emails = (c.contact_emails || []).map((e: any) => e.email).filter(Boolean) as string[];
      em[c.id] = emails;
      return { id: c.id, name: c.name, email: emails[0], emails };
    }));
    setContactEmailsMap(em);
  };

  const loadLinkedMeetings = async () => {
    if (!user) return;
    const meetings = await getMeetings(user.id) as Meeting[];
    const map: Record<string, Meeting> = {};
    meetings.forEach(m => { if (m.calendar_event_id) map[m.calendar_event_id] = m; });
    setLinkedMeetings(map);
  };

  const checkCalendarConnection = async () => {
    try { const r = await fetch("/api/calendar/availability"); if (r.ok) { setCalendarConnected(true); } } catch {}
  };

  const handleSync = async () => {
    setSyncing(true); setError("");
    try {
      await fetch("/api/calendar/sync?force=true", { method: "POST" });
      await loadEvents(); await loadLinkedMeetings();
    } catch { setError("Failed to sync calendar"); }
    finally { setSyncing(false); }
  };

  const fmtHour = (h: number) => h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;

  // ── Meeting form helpers
  const openNewMeetingForm = (prefill?: Partial<typeof emptyForm>, duration?: number) => {
    setEditingMeeting(null);
    setFormData({ ...emptyForm, ...prefill });
    setSelectedContactIds([]);
    setInviteEmailMap({});
    setMeetingDuration(duration ?? 0);
    setShowMeetingForm(true);
  };

  const openEditFromEvent = (event: CalendarEvent) => {
    setSelectedEvent(null);
    const linked = linkedMeetings[event.google_event_id];
    if (linked) {
      const d = new Date(linked.meeting_date);
      setEditingMeeting(linked);
      setFormData({
        meeting_date: dateToStr(d),
        meeting_time: `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`,
        meeting_type: linked.meeting_type,
        title: (linked as any).title || "",
        notes: linked.notes || "",
        privateNotes: (linked as any).private_notes || "",
        calendarDescription: (linked as any).calendar_description || "",
        transcript: linked.transcript || "",
      });
      setSelectedContactIds(linked.meeting_contacts.map(mc => mc.contact_id));
    } else {
      const start = new Date(event.start_at);
      const end = new Date(event.end_at);
      setEditingMeeting(null);
      setFormData({
        ...emptyForm,
        title: event.title || "",
        meeting_date: dateToStr(start),
        meeting_time: `${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`,
      });
      setSelectedContactIds(event.contact_id ? [event.contact_id] : []);
      setMeetingDuration(Math.round((end.getTime() - start.getTime()) / 60000));
    }
    setContactSearch(""); setInviteEmailMap({});
    setShowMeetingForm(true);
  };

  const closeMeetingForm = () => {
    setShowMeetingForm(false); setEditingMeeting(null);
    setFormData(emptyForm); setSelectedContactIds([]);
    setContactSearch(""); setInviteEmailMap({});
    setMeetingDuration(60);
  };

  const handleSaveMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const dateTime = formData.meeting_date && formData.meeting_time
      ? `${formData.meeting_date}T${formData.meeting_time}` : formData.meeting_date;
    const autoSummary = formData.title ||
      (formData.meeting_type ? `${formData.meeting_type.charAt(0).toUpperCase() + formData.meeting_type.slice(1).replace("-"," ")} with ${selectedContactIds.map(id => allContacts.find(c => c.id === id)?.name).filter(Boolean).join(", ") || "Contact"}` : "Meeting");
    try {
      if (editingMeeting) {
        await updateMeeting(editingMeeting.id, {
          meeting_date: dateTime, meeting_type: formData.meeting_type,
          title: formData.title || null, notes: formData.notes || null,
          private_notes: formData.privateNotes || null,
          calendar_description: formData.calendarDescription || null,
          transcript: formData.transcript || null,
        });
        await replaceContactsForMeeting(editingMeeting.id, selectedContactIds);
        // Update linked Google Calendar event if one exists
        if (calendarConnected && editingMeeting.calendar_event_id && formData.meeting_time) {
          const effectiveDuration = meetingDuration > 0 ? meetingDuration : 60;
          const startTime = new Date(dateTime).toISOString();
          const endTime = new Date(new Date(dateTime).getTime() + effectiveDuration * 60000).toISOString();
          await fetch(`/api/calendar/events/${encodeURIComponent(editingMeeting.calendar_event_id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: autoSummary, description: formData.calendarDescription || undefined, startTime, endTime }),
          }).catch(() => {}); // Best-effort — don't fail the whole save
        }
      } else {
        const created = await createMeeting({
          user_id: user.id, meeting_date: dateTime, meeting_type: formData.meeting_type,
          title: formData.title || null, notes: formData.notes || null,
          private_notes: formData.privateNotes || null,
          calendar_description: formData.calendarDescription || null,
          transcript: formData.transcript || null,
        });
        if (selectedContactIds.length > 0) await addContactsToMeeting(created.id, selectedContactIds);
        // Always create on Google Calendar when connected and time is set
        if (calendarConnected && formData.meeting_time) {
          const effectiveDuration = meetingDuration > 0 ? meetingDuration : 60; // Default 1 hour
          const attendeeEmails = selectedContactIds.map(id => inviteEmailMap[id] || contactEmailsMap[id]?.[0] || allContacts.find(c => c.id === id)?.email || null).filter(Boolean) as string[];
          const startTime = new Date(dateTime).toISOString();
          const endTime = new Date(new Date(dateTime).getTime() + effectiveDuration * 60000).toISOString();
          await fetch("/api/calendar/create-event", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: autoSummary, description: formData.calendarDescription || undefined, startTime, endTime, attendeeEmails, conferenceType: includeMeetLink ? "meet" : "none", meetingId: created.id }) });
        }
      }
      await loadLinkedMeetings(); await loadEvents();
      closeMeetingForm();
      toast(editingMeeting ? "Meeting updated" : "Meeting created", { variant: "success" });
    } catch (err) {
      console.error("Error saving meeting:", err);
      toast("Failed to save meeting", { variant: "error" });
    }
  };

  // ── Drag-to-create (week view)
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: MouseEvent) => {
      if (!gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const raw = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
      setDragState(prev => prev ? { ...prev, currentMins: Math.max(0, Math.min(GRID_HOURS * 60, snapMins(raw))) } : null);
    };
    const onUp = () => {
      if (dragState) {
        const startMins = Math.min(dragState.startMins, dragState.currentMins);
        const endMins = Math.max(dragState.startMins, dragState.currentMins);
        const diff = endMins - startMins;
        openNewMeetingForm({
          meeting_date: dateToStr(dragState.day),
          meeting_time: minsToTimeStr(startMins),
        }, diff >= 15 ? diff : undefined);
      }
      setDragState(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [dragState]);

  if (!user) return null;

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-4 text-muted-foreground">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
            <span className="text-base">Loading calendar…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" onClick={() => selectedEvent && setSelectedEvent(null)}>
      <Navigation />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

        {/* ── Header ── */}
        <div className="mb-7 flex items-center justify-between gap-5 flex-wrap">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Calendar</h1>
            <p className="text-base text-muted-foreground mt-1">
              {view === "week"
                ? `${weekLabel} · ${weekDays[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : `${filteredEvents.length} events`}
            </p>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Filter pill */}
            <div className="flex rounded-full border border-outline-variant overflow-hidden text-sm">
              {(["all", "contacts", "no-contacts"] as ContactFilter[]).map(f => (
                <button key={f} onClick={() => setContactFilter(f)}
                  className={`px-4 py-2 font-medium transition-colors ${contactFilter === f ? "bg-secondary-container text-on-secondary-container" : "text-muted-foreground hover:bg-surface-container-low"}`}>
                  {f === "all" ? "All" : f === "contacts" ? "With contacts" : "No contacts"}
                </button>
              ))}
            </div>
            {/* Week nav (week view only) */}
            {view === "week" && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setWeekOffset(w => w - 1)} className="p-2 rounded-full hover:bg-surface-container-low transition-colors text-muted-foreground hover:text-foreground"><ChevronLeft className="h-5 w-5" /></button>
                <button onClick={() => setWeekOffset(0)} className="px-3 py-1.5 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors">{weekLabel}</button>
                <button onClick={() => setWeekOffset(w => w + 1)} className="p-2 rounded-full hover:bg-surface-container-low transition-colors text-muted-foreground hover:text-foreground"><ChevronRight className="h-5 w-5" /></button>
              </div>
            )}
            {/* View toggle */}
            <div className="flex rounded-full border border-outline-variant overflow-hidden">
              <button onClick={() => setView("list")} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"}`}><List className="h-4 w-4" /> List</button>
              <button onClick={() => setView("week")} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${view === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"}`}><LayoutGrid className="h-4 w-4" /> Week</button>
            </div>
            <Button variant="tonal" onClick={() => openNewMeetingForm()}><Plus className="h-5 w-5" /> Add meeting</Button>
            <Button onClick={handleSync} loading={syncing}><RefreshCw className={`h-5 w-5 ${syncing ? "animate-spin" : ""}`} /> Sync</Button>
          </div>
        </div>

        {error && (
          <div className="mb-5 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-base text-destructive">
            {error}
          </div>
        )}

        {/* ── Week Grid View ── */}
        {view === "week" && (
          <div className="overflow-x-auto relative">
            <div className="min-w-[640px]">
              {/* Day headers */}
              <div className="grid grid-cols-[48px_repeat(7,1fr)] mb-1">
                <div />
                {weekDays.map((day, i) => {
                  const isToday = day.toDateString() === new Date().toDateString();
                  return (
                    <div key={i} className="text-center pb-2 border-b border-outline-variant/50">
                      <p className="text-[11px] text-muted-foreground">{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]}</p>
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
                  {weekDays.map((day, i) => (
                    <div key={i} className="px-0.5 py-0.5 min-h-[24px]">
                      {weekEvents.filter(e => e.all_day && e.start_at.slice(0, 10) === dateToStr(day)).map(e => (
                        <div key={e.id} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary truncate">{e.is_private ? "Busy" : (e.title || "Untitled")}</div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* Time grid with drag-to-create */}
              <div ref={gridRef} className="relative select-none" style={{ height: `${GRID_HOURS * HOUR_HEIGHT}px` }}>
                {/* Hour lines */}
                {Array.from({ length: GRID_HOURS }, (_, i) => (
                  <div key={i} className="absolute left-0 right-0 border-t border-outline-variant/30" style={{ top: `${i * HOUR_HEIGHT}px` }}>
                    <span className="text-[10px] text-muted-foreground absolute w-[44px] text-right pr-2 -mt-[6px] select-none left-0">{fmtHour(GRID_START_HOUR + i)}</span>
                  </div>
                ))}

                {/* Day columns */}
                {weekDays.map((day, colIdx) => {
                  const isToday = day.toDateString() === new Date().toDateString();
                  const dayEvents = weekEvents.filter(e => !e.all_day && new Date(e.start_at).toDateString() === day.toDateString());
                  const isDragDay = dragState?.day.toDateString() === day.toDateString();
                  const dragTop = isDragDay ? (Math.min(dragState!.startMins, dragState!.currentMins) / 60) * HOUR_HEIGHT : 0;
                  const dragH = isDragDay ? (Math.abs(dragState!.currentMins - dragState!.startMins) / 60) * HOUR_HEIGHT : 0;

                  return (
                    <div
                      key={colIdx}
                      className={`absolute border-l border-outline-variant/30 cursor-crosshair ${isToday ? "bg-primary/[0.02]" : ""}`}
                      style={{ left: `calc(48px + (100% - 48px) * ${colIdx} / 7)`, width: `calc((100% - 48px) / 7)`, top: 0, height: "100%" }}
                      onMouseDown={(e) => {
                        if ((e.target as HTMLElement).closest("[data-event]")) return;
                        const rect = gridRef.current!.getBoundingClientRect();
                        const raw = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
                        const mins = Math.max(0, Math.min(GRID_HOURS * 60 - 15, snapMins(raw)));
                        setDragState({ day, startMins: mins, currentMins: mins });
                        e.preventDefault();
                      }}
                    >
                      {/* Drag selection highlight */}
                      {isDragDay && dragH > 0 && (
                        <div className="absolute left-0.5 right-0.5 bg-primary/20 border border-primary/40 rounded pointer-events-none z-10"
                          style={{ top: `${dragTop}px`, height: `${Math.max(4, dragH)}px` }} />
                      )}

                      {/* Events */}
                      {dayEvents.map(event => {
                        const start = new Date(event.start_at);
                        const end = new Date(event.end_at);
                        const sm = (start.getHours() - GRID_START_HOUR) * 60 + start.getMinutes();
                        const em = (end.getHours() - GRID_START_HOUR) * 60 + end.getMinutes();
                        const top = (Math.max(0, sm) / 60) * HOUR_HEIGHT;
                        const height = Math.max(18, ((Math.min(GRID_HOURS * 60, em) - Math.max(0, sm)) / 60) * HOUR_HEIGHT - 2);
                        const isSelected = selectedEvent?.id === event.id;
                        return (
                          <div
                            key={event.id}
                            data-event="1"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (event.is_private) return;
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              const alignRight = rect.left > window.innerWidth / 2;
                              setBubblePos({ top: rect.top, left: alignRight ? rect.left - 4 : rect.right + 4, alignRight });
                              setSelectedEvent(isSelected ? null : event);
                            }}
                            className={`absolute left-0.5 right-0.5 rounded px-1 py-0.5 overflow-hidden text-[10px] leading-tight cursor-pointer transition-shadow hover:shadow-md ${
                              event.is_private ? "bg-surface-container text-muted-foreground border border-outline-variant/50" : "bg-primary/15 text-primary border border-primary/20"
                            } ${isSelected ? "ring-2 ring-primary" : ""}`}
                            style={{ top: `${top}px`, height: `${height}px` }}
                          >
                            {event.is_private ? <span className="flex items-center gap-0.5"><Lock className="h-2.5 w-2.5 shrink-0" /> Busy</span> : (
                              <>
                                <div className="font-medium truncate">{event.title || "Untitled"}</div>
                                {height > 32 && <div className="truncate text-primary/70">{start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}{event.recurring_event_id && " ↻"}{event.meet_link && " ·vid"}</div>}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Current time line */}
                {(() => {
                  const now = new Date();
                  const mins = (now.getHours() - GRID_START_HOUR) * 60 + now.getMinutes();
                  if (mins < 0 || mins > GRID_HOURS * 60) return null;
                  const ci = weekDays.findIndex(d => d.toDateString() === now.toDateString());
                  if (ci < 0) return null;
                  return <div className="absolute h-0.5 bg-primary/70 z-20 pointer-events-none" style={{ top: `${(mins / 60) * HOUR_HEIGHT}px`, left: `calc(48px + (100% - 48px) * ${ci} / 7)`, width: `calc((100% - 48px) / 7)` }} />;
                })()}
              </div>
            </div>

            {/* Event detail bubble */}
            {selectedEvent && (
              <div
                className="fixed z-50 w-80 bg-surface-container-high rounded-[16px] shadow-xl border border-outline-variant/50 p-5"
                style={{ top: `${bubblePos.top}px`, ...(bubblePos.alignRight ? { right: `${window.innerWidth - bubblePos.left}px` } : { left: `${bubblePos.left}px` }) }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-2.5 mb-2.5">
                  <h3 className="text-base font-medium text-foreground">{selectedEvent.title || "Untitled"}</h3>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => openEditFromEvent(selectedEvent)} className="p-2 rounded-full hover:bg-surface-container text-muted-foreground hover:text-primary transition-colors cursor-pointer" title="Edit meeting"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => setSelectedEvent(null)} className="p-2 rounded-full hover:bg-surface-container text-muted-foreground transition-colors cursor-pointer"><X className="h-4 w-4" /></button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-1.5">
                  {new Date(selectedEvent.start_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} – {new Date(selectedEvent.end_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                </p>
                {selectedEvent.location && <p className="text-sm text-muted-foreground flex items-center gap-1.5 mb-1.5"><MapPin className="h-3.5 w-3.5" />{selectedEvent.location}</p>}
                {selectedEvent.meet_link && <a href={selectedEvent.meet_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline mb-1.5"><Video className="h-3.5 w-3.5" />Join meeting</a>}
                {selectedEvent.description && <p className="text-sm text-muted-foreground mt-1.5 line-clamp-3">{selectedEvent.description}</p>}
                {selectedEvent.attendees.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-outline-variant/50 space-y-1">
                    {selectedEvent.attendees.slice(0, 5).map((a, i) => {
                      const { className: sc, label: sl } = getRsvpDisplay(a.responseStatus);
                      const displayName = contactEmailToName[a.email?.toLowerCase()] || a.name || a.email;
                      return <div key={i} className="flex items-center gap-2 text-sm"><span className={`font-semibold ${sc}`}>{sl}</span><span className="text-foreground truncate">{displayName}</span></div>;
                    })}
                    {selectedEvent.attendees.length > 5 && <p className="text-xs text-muted-foreground">+{selectedEvent.attendees.length - 5} more</p>}
                  </div>
                )}
                {linkedMeetings[selectedEvent.google_event_id] && (
                  <p className="text-xs text-primary mt-2.5">Linked to Activity log</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── List View ── */}
        {view === "list" && (
          filteredEvents.length === 0 ? (
            <Card variant="outlined">
              <CardContent className="p-14 text-center text-muted-foreground">
                <p className="text-base mb-1">No events</p>
                <p className="text-sm">{contactFilter !== "all" ? "Try changing the filter" : "Sync your Google Calendar to see events"}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredEvents.map((event) => {
                // All-day events are stored as UTC midnight — parse date parts in UTC to avoid timezone shift
                const sd = event.all_day ? new Date(event.start_at.slice(0, 10) + "T12:00:00") : new Date(event.start_at);
                const ed = event.all_day ? new Date(event.end_at.slice(0, 10) + "T12:00:00") : new Date(event.end_at);
                const isToday = sd.toDateString() === new Date().toDateString();
                const timeStr = sd.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
                const endStr = ed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
                return (
                  <div key={event.id} className="group rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200 p-5">
                    <div className="flex items-start gap-5">
                      <div className="shrink-0 w-16 text-center">
                        <p className="text-xs text-muted-foreground">{sd.toLocaleDateString("en-US", { weekday: "short", month: "short" })}</p>
                        <p className={`text-xl font-semibold leading-none mt-0.5 ${isToday ? "text-primary" : "text-foreground"}`}>{sd.getDate()}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2.5">
                          <div className="min-w-0">
                            {event.is_private ? (
                              <div className="flex items-center gap-2.5"><Lock className="h-5 w-5 text-muted-foreground" /><span className="text-base text-muted-foreground">Private event</span></div>
                            ) : (
                              <h3 className="text-base font-medium text-foreground">{event.title || "Untitled"}</h3>
                            )}
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {event.all_day ? "All day" : `${timeStr} – ${endStr}`}
                              {event.location && <span> · <MapPin className="h-3.5 w-3.5 inline" /> {event.location}</span>}
                              {event.recurring_event_id && <span> · <RotateCcw className="h-3.5 w-3.5 inline" /></span>}
                            </p>
                          </div>
                          {!event.is_private && (
                            <button
                              onClick={() => openEditFromEvent(event)}
                              className="p-2 rounded-full opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary hover:bg-surface-container-low transition-all cursor-pointer shrink-0"
                              title="Edit / log meeting"
                            >
                              <Pencil className="h-5 w-5" />
                            </button>
                          )}
                        </div>
                        {event.meet_link && (
                          <a href={event.meet_link} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-2.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors">
                            <Video className="h-3.5 w-3.5" /> Join meeting
                          </a>
                        )}
                        {!event.is_private && event.attendees.length > 0 && (
                          <div className="mt-2.5 pt-2.5 border-t border-outline-variant/40 flex flex-wrap gap-x-4 gap-y-1">
                            {event.attendees.map((a, i) => {
                              const sc = { accepted: "text-primary", declined: "text-destructive", tentative: "text-tertiary", needsAction: "text-muted-foreground" }[a.responseStatus] || "text-muted-foreground";
                              const sl = { accepted: "✓", declined: "✗", tentative: "?", needsAction: "–" }[a.responseStatus] || "–";
                              const displayName = contactEmailToName[a.email?.toLowerCase()] || a.name || a.email;
                              return <span key={i} className="text-sm text-foreground"><span className={`font-semibold ${sc}`}>{sl}</span> {displayName}</span>;
                            })}
                          </div>
                        )}
                        {linkedMeetings[event.google_event_id] && (
                          <span className="inline-block mt-2 text-xs text-primary">Logged in Activity</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ── Meeting Form Modal ── */}
        {showMeetingForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
            <div className="absolute inset-0 bg-black/32" onClick={closeMeetingForm} />
            <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
              <div className="px-7 pt-7 pb-5">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">{editingMeeting ? "Edit meeting" : "New meeting"}</h2>
              </div>
              <form onSubmit={handleSaveMeeting} className="px-7 pb-7 space-y-5">
                <div>
                  <label className={labelClasses}>Meeting name</label>
                  <input type="text" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} className={inputClasses} placeholder="e.g. Coffee with Alex…" />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div><label className={labelClasses}>Date *</label><DatePicker value={formData.meeting_date} onChange={v => setFormData({...formData, meeting_date: v})} required /></div>
                  <div><label className={labelClasses}>Time</label><TimePicker value={formData.meeting_time} onChange={v => setFormData({...formData, meeting_time: v})} /></div>
                  <div>
                    <label className={labelClasses}>Type *</label>
                    <Select required value={formData.meeting_type} onChange={v => setFormData({...formData, meeting_type: v})} placeholder="Select…" options={[...CONVERSATION_TYPE_OPTIONS]} />
                  </div>
                </div>
                {/* Contacts */}
                <div>
                  <label className={labelClasses}>Contacts</label>
                  {selectedContactIds.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2.5">
                      {selectedContactIds.map(id => {
                        const c = allContacts.find(c => c.id === id);
                        if (!c) return null;
                        const emails = contactEmailsMap[id] || [];
                        const selEmail = inviteEmailMap[id] || emails[0];
                        return (
                          <div key={id} className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5 h-9 pl-4 pr-2 rounded-full bg-secondary-container text-sm text-on-secondary-container font-medium">
                              {c.name}
                              <button type="button" onClick={() => { setSelectedContactIds(selectedContactIds.filter(i => i !== id)); setInviteEmailMap(p => { const n = {...p}; delete n[id]; return n; }); }} className="p-0.5 rounded-full hover:bg-black/10 cursor-pointer"><X className="h-3.5 w-3.5" /></button>
                            </span>
                            {emails.length > 1 && calendarConnected && (
                              <div className="flex items-center gap-1 pl-1 flex-wrap">
                                <span className="text-[10px] text-muted-foreground">Invite:</span>
                                {emails.map(email => (
                                  <button key={email} type="button" onClick={() => setInviteEmailMap(p => ({...p, [id]: email}))}
                                    className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${selEmail === email ? "bg-primary text-primary-foreground" : "bg-surface-container-low text-muted-foreground hover:text-foreground"}`}>
                                    {email}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
                    <input type="text" value={contactSearch} onChange={e => setContactSearch(e.target.value)} className={`${inputClasses} !pl-11`} placeholder="Search contacts…" />
                  </div>
                  {contactSearch.trim() && (
                    <div className="mt-1 max-h-36 overflow-y-auto rounded-[12px] border border-outline-variant bg-surface-container-high">
                      {allContacts.filter(c => !selectedContactIds.includes(c.id) && c.name.toLowerCase().includes(contactSearch.toLowerCase())).slice(0, 6).map(c => (
                        <button key={c.id} type="button" onClick={() => { setSelectedContactIds([...selectedContactIds, c.id]); setContactSearch(""); }}
                          className="w-full text-left px-5 py-3 flex items-center gap-2.5 hover:bg-surface-container cursor-pointer transition-colors text-base">{c.name}</button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Notes (future vs past) */}
                {isFutureMeeting ? (
                  <div><label className={labelClasses}>Private reminder notes</label>
                    <textarea value={formData.privateNotes} onChange={e => setFormData({...formData, privateNotes: e.target.value})} className={`${inputClasses} !h-auto py-3`} rows={4} placeholder="Topics to discuss, things to remember…" />
                  </div>
                ) : (
                  <>
                    <div><label className={labelClasses}>Notes</label><textarea value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} className={`${inputClasses} !h-auto py-3`} rows={4} placeholder="Key takeaways…" /></div>
                    <div><label className={labelClasses}>Transcript</label><textarea value={formData.transcript} onChange={e => setFormData({...formData, transcript: e.target.value})} className={`${inputClasses} !h-auto py-3`} rows={8} placeholder="Paste transcript…" /></div>
                  </>
                )}
                {/* Calendar options — shown when connected and time is set */}
                {calendarConnected && !editingMeeting && formData.meeting_time && (
                  <div className="rounded-[12px] border border-outline-variant/60 p-5 space-y-4">
                    <div><label className={labelClasses}>Calendar invite description</label>
                      <textarea value={formData.calendarDescription} onChange={e => setFormData({...formData, calendarDescription: e.target.value})} className={`${inputClasses} !h-auto py-3`} rows={2} placeholder="Agenda or notes for the invite…" />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-base text-muted-foreground flex items-center gap-2.5"><Video className="h-5 w-5" /> Include Google Meet link</label>
                      <Toggle checked={includeMeetLink} onChange={setIncludeMeetLink} />
                    </div>
                    <div><label className={labelClasses}>Duration</label>
                      <select value={meetingDuration} onChange={e => setMeetingDuration(Number(e.target.value))} className={inputClasses}>
                        {meetingDuration === 0 && <option value={0} disabled>Select duration…</option>}
                        {[15,30,45,60,90,120].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m/60} hours`}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                <div className="flex justify-end gap-2.5 pt-3">
                  <Button type="button" variant="text" onClick={closeMeetingForm}>Cancel</Button>
                  <Button type="submit">{editingMeeting ? "Save" : "Create"}</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
