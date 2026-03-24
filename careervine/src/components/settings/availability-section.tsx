"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Calendar, AlertCircle } from "lucide-react";
import Link from "next/link";
import { useGmailConnection } from "@/hooks/use-gmail-connection";

const dayLabels = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type DayConfig = { day: number; enabled: boolean; startTime: string; endTime: string; bufferBefore: number; bufferAfter: number };
type AvailabilityProfile = { workingDays: DayConfig[] };

const defaultStandard: AvailabilityProfile = {
  workingDays: Array.from({ length: 7 }, (_, i) => ({
    day: i, enabled: i < 5, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10,
  })),
};

const defaultPriority: AvailabilityProfile = {
  workingDays: Array.from({ length: 7 }, (_, i) => ({
    day: i, enabled: i < 5, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15,
  })),
};

export default function AvailabilitySection() {
  const { user } = useAuth();
  const { data: connData, loading, calendarConnected } = useGmailConnection();
  const [activeTab, setActiveTab] = useState<"standard" | "priority">("standard");
  const [standard, setStandard] = useState<AvailabilityProfile>(defaultStandard);
  const [priority, setPriority] = useState<AvailabilityProfile>(defaultPriority);
  const [saving, setSaving] = useState(false);
  const [calendarList, setCalendarList] = useState<Array<{ id: string; summary: string; accessRole: string }>>([]);
  const [busyCalendarIds, setBusyCalendarIds] = useState<string[]>(["primary"]);
  const [savingBusyCalendars, setSavingBusyCalendars] = useState(false);
  const [calendarTimezone, setCalendarTimezone] = useState("");
  const [savedAvailability, setSavedAvailability] = useState(false);
  const [savedBusyCalendars, setSavedBusyCalendars] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Hydrate local state from shared connection data
  useEffect(() => {
    if (!connData) return;
    if (connData.availability_standard) setStandard(connData.availability_standard as AvailabilityProfile);
    if (connData.availability_priority) setPriority(connData.availability_priority as AvailabilityProfile);
    if (connData.calendar_list) setCalendarList(connData.calendar_list);
    if (connData.busy_calendar_ids) setBusyCalendarIds(connData.busy_calendar_ids);
    if (connData.calendar_timezone) setCalendarTimezone(connData.calendar_timezone);
  }, [connData]);

  const handleSaveAvailability = async () => {
    setSaveError("");
    // Validate endTime > startTime for enabled days
    const profile = activeTab === "standard" ? standard : priority;
    const invalidDay = profile.workingDays.find((d) => d.enabled && d.endTime <= d.startTime);
    if (invalidDay) {
      setSaveError(`${dayLabels[invalidDay.day]}: end time must be after start time.`);
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/calendar/availability-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: activeTab, data: profile }),
      });
      if (!res.ok) throw new Error("Failed to save availability");
      setSavedAvailability(true);
      setTimeout(() => setSavedAvailability(false), 2500);
    } catch (err) {
      console.error("Error saving availability:", err);
      setSaveError(err instanceof Error ? err.message : "Failed to save availability");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBusyCalendars = async () => {
    try {
      setSavingBusyCalendars(true);
      const res = await fetch("/api/calendar/busy-calendars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ busyCalendarIds }),
      });
      if (!res.ok) throw new Error("Failed to save calendar selection");
      setSavedBusyCalendars(true);
      setTimeout(() => setSavedBusyCalendars(false), 2500);
    } catch (err) {
      console.error("Error saving busy calendars:", err);
      setSaveError(err instanceof Error ? err.message : "Failed to save calendar selection");
    } finally {
      setSavingBusyCalendars(false);
    }
  };

  const updateDay = (idx: number, updates: Partial<DayConfig>) => {
    const setter = activeTab === "standard" ? setStandard : setPriority;
    const profile = activeTab === "standard" ? standard : priority;
    setter({
      ...profile,
      workingDays: profile.workingDays.map((d, i) => (i === idx ? { ...d, ...updates } : d)),
    });
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-4 text-muted-foreground py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
        <span className="text-base">Loading availability...</span>
      </div>
    );
  }

  if (!calendarConnected) {
    return (
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-5">
            <Calendar className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Availability</h2>
          </div>
          <div className="flex gap-4 p-5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
            <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-base font-medium text-amber-800 dark:text-amber-300">Google Calendar required</p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                Connect your Google Calendar in the{" "}
                <Link href="/settings?tab=integrations" className="underline font-medium">Integrations</Link>{" "}
                section to configure your availability and schedule meetings.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const currentProfile = activeTab === "standard" ? standard : priority;

  return (
    <div className="space-y-7">
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-6">
            <Calendar className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Working hours</h2>
          </div>

          {/* Profile tabs */}
          <div className="flex gap-3 mb-5 border-b border-outline-variant">
            <button
              type="button"
              onClick={() => setActiveTab("standard")}
              className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === "standard"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Standard Availability
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("priority")}
              className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === "priority"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Priority Availability
            </button>
          </div>

          <div className="space-y-4">
            {currentProfile.workingDays.map((dayConfig, idx) => (
              <div key={dayConfig.day} className="p-4 rounded-lg border border-outline-variant/50 hover:bg-surface-container-low/50 transition-colors">
                <div className="flex items-center gap-4 mb-4">
                  <input
                    type="checkbox"
                    checked={dayConfig.enabled}
                    onChange={(e) => updateDay(idx, { enabled: e.target.checked })}
                    className="w-5 h-5 cursor-pointer"
                  />
                  <label className="text-base font-medium text-foreground flex-1 cursor-pointer">
                    {dayLabels[dayConfig.day]}
                  </label>
                </div>
                {dayConfig.enabled && (
                  <div className="grid grid-cols-2 gap-3 ml-9">
                    <div>
                      <label className="text-xs text-muted-foreground">Start</label>
                      <input
                        type="time"
                        value={dayConfig.startTime}
                        onChange={(e) => updateDay(idx, { startTime: e.target.value })}
                        className="w-full h-9 px-3 bg-surface-container-low text-foreground rounded text-sm border border-outline"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">End</label>
                      <input
                        type="time"
                        value={dayConfig.endTime}
                        onChange={(e) => updateDay(idx, { endTime: e.target.value })}
                        className="w-full h-9 px-3 bg-surface-container-low text-foreground rounded text-sm border border-outline"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Buffer before (min)</label>
                      <input
                        type="number"
                        value={dayConfig.bufferBefore}
                        onChange={(e) => updateDay(idx, { bufferBefore: parseInt(e.target.value) || 0 })}
                        className="w-full h-9 px-3 bg-surface-container-low text-foreground rounded text-sm border border-outline"
                        min="0"
                        step="5"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Buffer after (min)</label>
                      <input
                        type="number"
                        value={dayConfig.bufferAfter}
                        onChange={(e) => updateDay(idx, { bufferAfter: parseInt(e.target.value) || 0 })}
                        className="w-full h-9 px-3 bg-surface-container-low text-foreground rounded text-sm border border-outline"
                        min="0"
                        step="5"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {saveError && <p className="text-base text-destructive mt-4">{saveError}</p>}

          <div className="flex items-center gap-4 pt-5">
            <Button type="button" loading={saving} onClick={handleSaveAvailability}>
              Save availability
            </Button>
            {savedAvailability && (
              <span className="inline-flex items-center gap-1.5 text-base text-primary font-medium animate-pulse">
                Saved
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Busy calendars */}
      {calendarList.length > 0 && (
        <Card variant="outlined">
          <CardContent className="p-7">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-medium text-foreground">Count as busy</h3>
              {calendarTimezone && (
                <span className="text-xs text-muted-foreground">{calendarTimezone}</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Which calendars should block time when generating availability?
            </p>
            <div className="space-y-3">
              {calendarList.map((cal) => (
                <label key={cal.id} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={busyCalendarIds.includes(cal.id)}
                    onChange={(e) => {
                      setBusyCalendarIds(prev =>
                        e.target.checked ? [...prev, cal.id] : prev.filter(id => id !== cal.id)
                      );
                    }}
                    className="w-5 h-5 cursor-pointer"
                  />
                  <span className="text-base text-foreground flex-1">{cal.summary || cal.id}</span>
                  <span className="text-xs text-muted-foreground capitalize">{cal.accessRole}</span>
                </label>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-4"
              loading={savingBusyCalendars}
              onClick={handleSaveBusyCalendars}
            >
              Save calendar selection
            </Button>
            {savedBusyCalendars && (
              <span className="inline-flex items-center gap-1.5 text-base text-primary font-medium animate-pulse mt-5">
                Saved
              </span>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
