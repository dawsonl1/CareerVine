"use client";

import { useState, useEffect, useRef } from "react";
import { Calendar, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AvailabilityDay {
  date: string;
  label: string;
  slots: string[];
}

interface AvailabilityPickerProps {
  onInsert: (text: string) => void;
  recipientEmail?: string;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function AvailabilityPicker({ onInsert, recipientEmail }: AvailabilityPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState("");
  const [timezone, setTimezone] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const [duration, setDuration] = useState(30);
  const [daysAhead, setDaysAhead] = useState(7);
  const [daysOfWeek, setDaysOfWeek] = useState([1, 2, 3, 4, 5]);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [bufferBefore, setBufferBefore] = useState(10);
  const [bufferAfter, setBufferAfter] = useState(10);
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);
  const [detectedProfile, setDetectedProfile] = useState<"standard" | "priority">("standard");

  // Load saved profile from DB when picker opens
  useEffect(() => {
    if (!open) return;
    setProfileLoading(true);
    setError("");

    const load = async () => {
      try {
        const res = await fetch("/api/gmail/connection");
        const data = await res.json();
        const conn = data.connection;
        if (!conn) return;

        if (conn.calendar_timezone) setTimezone(conn.calendar_timezone);

        // Detect priority contact
        let isPriority = false;
        if (recipientEmail) {
          try {
            const r = await fetch(`/api/gmail/ai-write/resolve-contact?email=${encodeURIComponent(recipientEmail)}`);
            const cd = await r.json();
            if (cd.contactId) {
              const cr = await fetch(`/api/contacts/${cd.contactId}/tags`);
              if (cr.ok) {
                const { tags } = await cr.json();
                isPriority = tags?.some((t: string) => t.toLowerCase() === "priority") ?? false;
              }
            }
          } catch {}
        }

        const profileType: "standard" | "priority" = isPriority && conn.availability_priority ? "priority" : "standard";
        setDetectedProfile(profileType);
        const profile = profileType === "priority" ? conn.availability_priority : conn.availability_standard;

        if (profile) {
          // New per-day format: { workingDays: [...] }
          if (profile.workingDays) {
            const enabledDays = profile.workingDays
              .filter((d: any) => d.enabled)
              .map((d: any) => d.day + 1); // 0=Mon stored, picker uses 1=Mon
            if (enabledDays.length > 0) setDaysOfWeek(enabledDays);
            // Use the first enabled day's times as the window
            const first = profile.workingDays.find((d: any) => d.enabled);
            if (first) {
              setWindowStart(first.startTime || "09:00");
              setWindowEnd(first.endTime || "18:00");
              setBufferBefore(first.bufferBefore ?? 10);
              setBufferAfter(first.bufferAfter ?? 10);
            }
          } else if (profile.days) {
            // Legacy flat format
            if (profile.days?.length) setDaysOfWeek(profile.days);
            if (profile.windowStart) setWindowStart(profile.windowStart);
            if (profile.windowEnd) setWindowEnd(profile.windowEnd);
            if (profile.bufferBefore != null) setBufferBefore(profile.bufferBefore);
            if (profile.bufferAfter != null) setBufferAfter(profile.bufferAfter);
          }
        }
      } catch {}
      setProfileLoading(false);
    };

    load();
  }, [open, recipientEmail]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggleDay = (day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  };

  const handleInsert = async () => {
    setLoading(true);
    setError("");
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + daysAhead);

      const params = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
        daysOfWeek: daysOfWeek.join(","),
        windowStart,
        windowEnd,
        duration: String(duration),
        bufferBefore: String(bufferBefore),
        bufferAfter: String(bufferAfter),
      });

      const res = await fetch(`/api/calendar/availability?${params}`);
      const data = await res.json();

      if (data.notConnected) {
        setError("Connect Google Calendar in Settings to use this feature.");
        return;
      }
      if (data.neverSynced) {
        setError("Your calendar hasn't synced yet. Visit the Calendar page to sync.");
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to fetch availability");

      const days: AvailabilityDay[] = data.days || [];
      if (days.length === 0) {
        setError("No availability found for the selected range.");
        return;
      }

      const text = days
        .map((d) => `${d.label}: ${d.slots.join(", ")}`)
        .join("\n");

      onInsert(text);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load availability");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors border border-outline-variant"
      >
        <Calendar className="h-3.5 w-3.5" />
        Insert availability
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-80 bg-surface-container-high rounded-2xl shadow-lg border border-outline-variant p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Insert availability</p>
            {timezone && (
              <span className="text-[10px] text-muted-foreground bg-surface-container-low px-2 py-0.5 rounded-full">
                {timezone.split("/").pop()?.replace("_", " ")}
              </span>
            )}
          </div>

          {profileLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary border-t-transparent" />
              Loading your availability settings…
            </div>
          ) : (
            <>
              {/* Days of week */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Days</label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAY_LABELS.map((label, i) => {
                    const dayNum = i + 1;
                    return (
                      <button
                        key={dayNum}
                        type="button"
                        onClick={() => toggleDay(dayNum)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          daysOfWeek.includes(dayNum)
                            ? "bg-primary text-primary-foreground"
                            : "bg-surface-container-low text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Time window */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">From</label>
                  <input
                    type="time"
                    value={windowStart}
                    onChange={(e) => setWindowStart(e.target.value)}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">To</label>
                  <input
                    type="time"
                    value={windowEnd}
                    onChange={(e) => setWindowEnd(e.target.value)}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>

              {/* Duration & range */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Min slot</label>
                  <select
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  >
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={45}>45 min</option>
                    <option value={60}>1 hour</option>
                    <option value={90}>1.5 hrs</option>
                    <option value={120}>2 hrs</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Next</label>
                  <select
                    value={daysAhead}
                    onChange={(e) => setDaysAhead(Number(e.target.value))}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  >
                    <option value={3}>3 days</option>
                    <option value={5}>5 days</option>
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                  </select>
                </div>
              </div>

              {/* Buffer controls */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Buffer before (min)</label>
                  <input
                    type="number"
                    value={bufferBefore}
                    min={0}
                    step={5}
                    onChange={(e) => setBufferBefore(Number(e.target.value) || 0)}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Buffer after (min)</label>
                  <input
                    type="number"
                    value={bufferAfter}
                    min={0}
                    step={5}
                    onChange={(e) => setBufferAfter(Number(e.target.value) || 0)}
                    className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={async () => {
                    setSavingDefault(true);
                    try {
                      const profileData = {
                        workingDays: daysOfWeek.map(d => ({
                          day: d - 1,
                          enabled: true,
                          startTime: windowStart,
                          endTime: windowEnd,
                          bufferBefore,
                          bufferAfter,
                        })),
                      };
                      await fetch("/api/calendar/availability-profile", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ profile: detectedProfile, data: profileData }),
                      });
                      setSavedDefault(true);
                      setTimeout(() => setSavedDefault(false), 2000);
                    } catch {}
                    setSavingDefault(false);
                  }}
                  disabled={savingDefault}
                  className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
                >
                  {savedDefault ? "✓ Saved" : `Save as ${detectedProfile} default`}
                </button>
                <Button size="sm" onClick={handleInsert} loading={loading}>
                  Insert
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
