"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { Calendar, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/components/auth-provider";
import { getContactTagNames } from "@/lib/queries";
import { withToastOnError } from "@/lib/with-toast-on-error";
import type { AvailabilityDayConfig } from "@/lib/availability-profile";
import type { GmailConnectionData } from "@/hooks/use-gmail-connection";

interface AvailabilityDay {
  date: string;
  label: string;
  slots: string[];
}

interface AvailabilityPickerProps {
  onInsert: (text: string) => void;
  recipientEmail?: string;
}

type PickerMode = "standard" | "priority" | "custom";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── Stored availability shapes ──────────────────────────────────────────
// gmail_connections.availability_standard / availability_priority are Json
// columns, so they arrive as `unknown` (see GmailConnectionData) and get
// narrowed by the guards below. Two shapes are live on the wire: the current
// per-day one written by Settings and by this picker, and a legacy flat one
// that calendarAvailabilityProfileSchema still accepts.

/**
 * A working-day entry as stored. `day` and `enabled` are what
 * isWorkingDaysProfile validates; the rest stay optional because rows written
 * before calendarAvailabilityProfileSchema existed can omit them, which is why
 * every read below carries a default.
 */
type StoredWorkingDay = Pick<AvailabilityDayConfig, "day" | "enabled"> &
  Partial<Omit<AvailabilityDayConfig, "day" | "enabled">>;

type WorkingDaysProfile = { workingDays: StoredWorkingDay[] };

type LegacyAvailabilityProfile = {
  days?: number[];
  windowStart?: string;
  windowEnd?: string;
  bufferBefore?: number;
  bufferAfter?: number;
};

/** The custom-mode controls derived from either stored shape. */
type PickerState = {
  daysOfWeek: number[];
  windowStart: string;
  windowEnd: string;
  bufferBefore: number;
  bufferAfter: number;
};

/**
 * Field-wise view of an unknown value. Sound because every property read off
 * the result is typeof-guarded before use; mirrors normalizeAvailabilityProfile
 * in lib/availability-profile.ts.
 */
function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function isStoredWorkingDay(value: unknown): value is StoredWorkingDay {
  const d = asRecord(value);
  return !!d && typeof d.day === "number" && typeof d.enabled === "boolean";
}

/** Exported for tests: the guard both the summary and the insert path branch on. */
export function isWorkingDaysProfile(raw: unknown): raw is WorkingDaysProfile {
  const r = asRecord(raw);
  return !!r && Array.isArray(r.workingDays) && r.workingDays.every(isStoredWorkingDay);
}

/** Read the legacy flat fields off a stored blob, dropping anything mistyped. */
function toLegacyProfile(raw: unknown): LegacyAvailabilityProfile | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    days: Array.isArray(r.days) ? r.days.filter((d): d is number => typeof d === "number") : undefined,
    windowStart: typeof r.windowStart === "string" ? r.windowStart : undefined,
    windowEnd: typeof r.windowEnd === "string" ? r.windowEnd : undefined,
    bufferBefore: typeof r.bufferBefore === "number" ? r.bufferBefore : undefined,
    bufferAfter: typeof r.bufferAfter === "number" ? r.bufferAfter : undefined,
  };
}

/** Exported for tests: pure, and the only reader of the stored JSON shapes. */
export function profileToPickerState(profile: unknown): PickerState {
  let daysOfWeek = [1, 2, 3, 4, 5];
  let windowStart = "09:00";
  let windowEnd = "18:00";
  let bufferBefore = 10;
  let bufferAfter = 10;

  if (isWorkingDaysProfile(profile)) {
    const enabled = profile.workingDays.filter((d) => d.enabled);
    if (enabled.length) daysOfWeek = enabled.map((d) => d.day + 1);
    const first = enabled[0];
    if (first) {
      windowStart = first.startTime || "09:00";
      windowEnd = first.endTime || "18:00";
      bufferBefore = first.bufferBefore ?? 10;
      bufferAfter = first.bufferAfter ?? 10;
    }
  } else {
    // Legacy blobs are only recognised when they carry `days`, matching the
    // original `else if (profile?.days)` gate.
    const legacy = toLegacyProfile(profile);
    if (legacy?.days) {
      if (legacy.days.length) daysOfWeek = legacy.days;
      if (legacy.windowStart) windowStart = legacy.windowStart;
      if (legacy.windowEnd) windowEnd = legacy.windowEnd;
      if (legacy.bufferBefore != null) bufferBefore = legacy.bufferBefore;
      if (legacy.bufferAfter != null) bufferAfter = legacy.bufferAfter;
    }
  }
  return { daysOfWeek, windowStart, windowEnd, bufferBefore, bufferAfter };
}

export function AvailabilityPicker({ onInsert, recipientEmail }: AvailabilityPickerProps) {
  const { error: toastError } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState("");
  const [timezone, setTimezone] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Mode: standard | priority | custom
  const [mode, setMode] = useState<PickerMode>("standard");
  const [autoDetectedProfile, setAutoDetectedProfile] = useState<"standard" | "priority">("standard");
  const [, setHasStandard] = useState(false);
  const [hasPriority, setHasPriority] = useState(false);
  const [standardSummary, setStandardSummary] = useState("");
  const [prioritySummary, setPrioritySummary] = useState("");

  // Custom mode state
  const [duration, setDuration] = useState(30);
  const [daysAhead, setDaysAhead] = useState(7);
  const [daysOfWeek, setDaysOfWeek] = useState([1, 2, 3, 4, 5]);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [bufferBefore, setBufferBefore] = useState(10);
  const [bufferAfter, setBufferAfter] = useState(10);
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);

  // Profile data keyed by type. Stored as `unknown` because these are raw Json
  // column values; every read narrows through the guards above.
  const profileData = useRef<Record<"standard" | "priority", unknown>>({ standard: null, priority: null });

  const formatProfileSummary = (profile: unknown): string => {
    if (!profile) return "Not configured";
    const dayAbbr = ["M","T","W","Th","F","Sa","Su"];
    const fmt = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return `${h % 12 || 12}${m ? `:${String(m).padStart(2,"0")}` : ""}${h < 12 ? "am" : "pm"}`;
    };

    if (isWorkingDaysProfile(profile)) {
      const enabled = profile.workingDays.filter((d) => d.enabled);
      if (!enabled.length) return "No days configured";

      // Group days by their time window
      const groups = new Map<string, { days: number[]; ws: string; we: string }>();
      for (const day of enabled) {
        const ws = day.startTime || "09:00";
        const we = day.endTime || "18:00";
        const key = `${ws}|${we}`;
        if (!groups.has(key)) groups.set(key, { days: [], ws, we });
        groups.get(key)!.days.push(day.day + 1); // 1-indexed
      }

      return Array.from(groups.values())
        .map(g => `${g.days.map(d => dayAbbr[d - 1]).join("/")} · ${fmt(g.ws)}–${fmt(g.we)}`)
        .join(" · ");
    }

    // Legacy flat format
    const s = profileToPickerState(profile);
    const days = s.daysOfWeek.map((d: number) => dayAbbr[d - 1]).join("/");
    return `${days} · ${fmt(s.windowStart)}–${fmt(s.windowEnd)}`;
  };

  // Load profiles when picker opens
  useEffect(() => {
    if (!open) return;
    setProfileLoading(true);
    setError("");

    const load = async () => {
      try {
        const res = await fetch("/api/gmail/connection");
        const data: { connection: GmailConnectionData | null } = await res.json();
        const conn = data.connection;
        if (!conn) return;

        if (conn.calendar_timezone) setTimezone(conn.calendar_timezone);

        profileData.current.standard = conn.availability_standard || null;
        profileData.current.priority = conn.availability_priority || null;
        setHasStandard(!!conn.availability_standard);
        setHasPriority(!!conn.availability_priority);
        setStandardSummary(formatProfileSummary(conn.availability_standard));
        setPrioritySummary(formatProfileSummary(conn.availability_priority));

        // Detect priority contact to set default mode.
        //
        // CAR-158: this previously fetched `/api/contacts/{id}/tags`, a route
        // that has never existed in this repo. The `if (res.ok)` guard
        // swallowed the resulting 404, so `isPriority` was permanently false
        // and the picker never auto-selected the priority profile — a shipped
        // feature that had never once worked. Reading tags through the data
        // layer keeps it on RLS and needs no new API surface.
        let isPriority = false;
        if (recipientEmail && user) {
          try {
            const r = await fetch(`/api/gmail/ai-write/resolve-contact?email=${encodeURIComponent(recipientEmail)}`);
            const cd: { contactId?: number | null } = await r.json();
            if (cd.contactId) {
              const tags = await getContactTagNames(cd.contactId, user.id);
              isPriority = tags.some((t) => t.toLowerCase() === "priority");
            }
          } catch {
            // Priority-contact detection is best-effort; on failure the picker
            // falls back to the standard profile below.
          }
        }

        const detected: "standard" | "priority" =
          isPriority && conn.availability_priority ? "priority" : "standard";
        setAutoDetectedProfile(detected);
        setMode(detected);

        // Pre-populate custom controls from the detected profile
        const detectedProfile = detected === "priority" ? conn.availability_priority : conn.availability_standard;
        if (detectedProfile) {
          const s = profileToPickerState(detectedProfile);
          setDaysOfWeek(s.daysOfWeek);
          setWindowStart(s.windowStart);
          setWindowEnd(s.windowEnd);
          setBufferBefore(s.bufferBefore);
          setBufferAfter(s.bufferAfter);
        }
      } catch {
        // Best-effort load; on failure the picker falls back to its default
        // controls and the user can still pick availability manually.
      }
      setProfileLoading(false);
    };

    // `load` catches everything internally and always clears the loading flag.
    void load();
  }, [open, recipientEmail, user]);

  // Close on outside click
  useClickOutside(containerRef, useCallback(() => setOpen(false), []), open);

  const toggleDay = (day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  };

  const fetchDays = async (
    opts: { daysOfWeek: number[]; windowStart: string; windowEnd: string; bufferBefore: number; bufferAfter: number; duration: number; daysAhead: number },
    startDate: Date
  ): Promise<AvailabilityDay[]> => {
    const end = new Date(startDate);
    end.setDate(end.getDate() + opts.daysAhead);
    const params = new URLSearchParams({
      start: startDate.toISOString(),
      end: end.toISOString(),
      daysOfWeek: opts.daysOfWeek.join(","),
      windowStart: opts.windowStart,
      windowEnd: opts.windowEnd,
      duration: String(opts.duration),
      bufferBefore: String(opts.bufferBefore),
      bufferAfter: String(opts.bufferAfter),
    });
    const res = await fetch(`/api/calendar/availability?${params}`);
    const data: {
      days?: AvailabilityDay[];
      notConnected?: boolean;
      neverSynced?: boolean;
      error?: string;
    } = await res.json();
    if (data.notConnected) throw Object.assign(new Error("Connect Google Calendar in Settings to use this feature."), { code: "NOT_CONNECTED" });
    if (data.neverSynced) throw Object.assign(new Error("Your calendar hasn't synced yet. Visit the Calendar page to sync."), { code: "NEVER_SYNCED" });
    if (!res.ok) throw new Error(data.error || "Failed to fetch availability");
    return data.days || [];
  };

  const handleInsertProfile = async (profileType: "standard" | "priority") => {
    const p = profileData.current[profileType];
    if (!p) { setError(`No ${profileType} profile configured. Set it up in Settings.`); return; }

    setLoading(true);
    setError("");
    try {
      const startDate = new Date(); startDate.setHours(0, 0, 0, 0);
      const DAYS_AHEAD = 7;
      let allDays: AvailabilityDay[] = [];

      if (isWorkingDaysProfile(p)) {
        // Per-day settings: group working days by their time window
        const enabled = p.workingDays.filter((d) => d.enabled);
        if (!enabled.length) { setError("No working days configured in this profile."); return; }

        // Group days with identical settings together so we make one API call per group
        const groups = new Map<string, { daysOfWeek: number[]; windowStart: string; windowEnd: string; bufferBefore: number; bufferAfter: number }>();
        for (const day of enabled) {
          const ws = day.startTime || "09:00";
          const we = day.endTime || "18:00";
          const bb = day.bufferBefore ?? 10;
          const ba = day.bufferAfter ?? 10;
          const key = `${ws}|${we}|${bb}|${ba}`;
          if (!groups.has(key)) groups.set(key, { daysOfWeek: [], windowStart: ws, windowEnd: we, bufferBefore: bb, bufferAfter: ba });
          groups.get(key)!.daysOfWeek.push(day.day + 1); // day is 0-indexed, API expects 1-indexed
        }

        for (const g of groups.values()) {
          const days = await fetchDays({ ...g, duration: 30, daysAhead: DAYS_AHEAD }, startDate);
          allDays.push(...days);
        }
      } else {
        // Legacy flat profile format
        const s = profileToPickerState(p);
        allDays = await fetchDays({ ...s, duration: 30, daysAhead: DAYS_AHEAD }, startDate);
      }

      // Sort merged results by date
      allDays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (allDays.length === 0) { setError("No availability found for the next 7 days."); return; }
      onInsert(allDays.map((d) => `${d.label}: ${d.slots.join(", ")}`).join("\n"));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to load availability");
    } finally {
      setLoading(false);
    }
  };

  const handleInsertCustom = async () => {
    setLoading(true);
    setError("");
    try {
      const startDate = new Date(); startDate.setHours(0, 0, 0, 0);
      const days = await fetchDays({ daysOfWeek, windowStart, windowEnd, bufferBefore, bufferAfter, duration, daysAhead }, startDate);
      if (days.length === 0) { setError("No availability found for the selected range."); return; }
      onInsert(days.map((d) => `${d.label}: ${d.slots.join(", ")}`).join("\n"));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to load availability");
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full h-9 px-3 rounded-lg border border-outline bg-surface-container-low text-base text-foreground focus:outline-none focus:border-primary";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors border border-outline-variant"
      >
        <Calendar className="h-4 w-4" />
        Insert availability
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2.5 z-[9999] w-[340px] bg-surface-container-high rounded-2xl shadow-xl border border-outline-variant p-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <p className="text-base font-medium text-foreground">Insert availability</p>
            {timezone && (
              <span className="text-xs text-muted-foreground bg-surface-container-low px-2.5 py-0.5 rounded-full">
                {timezone.split("/").pop()?.replace(/_/g, " ")}
              </span>
            )}
          </div>

          {profileLoading ? (
            <div className="flex items-center gap-2.5 py-2.5 text-sm text-muted-foreground">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
              Loading…
            </div>
          ) : (
            <>
              {/* Mode selector */}
              <div className="flex rounded-xl overflow-hidden border border-outline-variant text-sm font-medium">
                {(["standard", "priority", "custom"] as PickerMode[]).map((m) => {
                  if (m === "priority" && !hasPriority) return null;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMode(m);
                        if (m !== "custom") {
                          const p = profileData.current[m];
                          if (p) {
                            const s = profileToPickerState(p);
                            setDaysOfWeek(s.daysOfWeek);
                            setWindowStart(s.windowStart);
                            setWindowEnd(s.windowEnd);
                            setBufferBefore(s.bufferBefore);
                            setBufferAfter(s.bufferAfter);
                          }
                        }
                        setError("");
                      }}
                      className={`flex-1 py-2 capitalize transition-colors ${
                        mode === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                      }`}
                    >
                      {m}
                      {m === autoDetectedProfile && mode !== m && (
                        <span className="ml-1 text-[9px] opacity-60">✦</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Standard / Priority: simple summary + insert */}
              {(mode === "standard" || mode === "priority") && (
                <div className="space-y-2.5">
                  <p className="text-sm text-muted-foreground">
                    {mode === "standard" ? standardSummary : prioritySummary}
                  </p>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <Button size="sm" className="w-full" onClick={() => handleInsertProfile(mode)} loading={loading}>
                    Insert {mode} availability
                  </Button>
                </div>
              )}

              {/* Custom: full controls */}
              {mode === "custom" && (
                <div className="space-y-4">
                  {/* Days */}
                  <div>
                    <label className="text-sm text-muted-foreground mb-2 block">Days</label>
                    <div className="flex gap-1.5 flex-wrap">
                      {DAY_LABELS.map((label, i) => {
                        const dayNum = i + 1;
                        return (
                          <button key={dayNum} type="button"
                            onClick={() => toggleDay(dayNum)}
                            className={`px-2.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                              daysOfWeek.includes(dayNum)
                                ? "bg-primary text-primary-foreground"
                                : "bg-surface-container-low text-muted-foreground hover:text-foreground"
                            }`}
                          >{label}</button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">From</label>
                      <input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} className={inputCls} />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">To</label>
                      <input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} className={inputCls} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">Min slot</label>
                      <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls}>
                        <option value={15}>15 min</option>
                        <option value={30}>30 min</option>
                        <option value={45}>45 min</option>
                        <option value={60}>1 hour</option>
                        <option value={90}>1.5 hrs</option>
                        <option value={120}>2 hrs</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">Next</label>
                      <select value={daysAhead} onChange={(e) => setDaysAhead(Number(e.target.value))} className={inputCls}>
                        <option value={3}>3 days</option>
                        <option value={5}>5 days</option>
                        <option value={7}>7 days</option>
                        <option value={14}>14 days</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">Buffer before (min)</label>
                      <input type="number" value={bufferBefore} min={0} step={5} onChange={(e) => setBufferBefore(Number(e.target.value) || 0)} className={inputCls} />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground mb-1.5 block">Buffer after (min)</label>
                      <input type="number" value={bufferAfter} min={0} step={5} onChange={(e) => setBufferAfter(Number(e.target.value) || 0)} className={inputCls} />
                    </div>
                  </div>

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <div className="flex items-center justify-between pt-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        setSavingDefault(true);
                        await withToastOnError(async () => {
                          const res = await fetch("/api/calendar/availability-profile", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              profile: autoDetectedProfile,
                              data: {
                                workingDays: daysOfWeek.map(d => ({
                                  day: d - 1, enabled: true,
                                  startTime: windowStart, endTime: windowEnd,
                                  bufferBefore, bufferAfter,
                                })),
                              },
                            }),
                          });
                          if (!res.ok) throw new Error(`save failed: ${res.status}`);
                          setSavedDefault(true);
                          setTimeout(() => setSavedDefault(false), 2000);
                        }, toastError, "Couldn't save your default availability. Please try again.");
                        setSavingDefault(false);
                      }}
                      disabled={savingDefault}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      {savedDefault ? "✓ Saved" : `Save as ${autoDetectedProfile} default`}
                    </button>
                    <Button size="sm" onClick={handleInsertCustom} loading={loading}>
                      Insert
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
