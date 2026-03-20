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
    try {
      setSaving(true);
      const profile = activeTab === "standard" ? standard : priority;
      const res = await fetch("/api/calendar/availability-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: activeTab, data: profile }),
      });
      if (!res.ok) throw new Error("Failed to save availability");
    } catch (err) {
      console.error("Error saving availability:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBusyCalendars = async () => {
    try {
      setSavingBusyCalendars(true);
      await fetch("/api/calendar/busy-calendars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ busyCalendarIds }),
      });
    } catch (err) {
      console.error("Error saving busy calendars:", err);
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
      <div className="flex items-center gap-3 text-muted-foreground py-8">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading availability...</span>
      </div>
    );
  }

  if (!calendarConnected) {
    return (
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">Availability</h2>
          </div>
          <div className="flex gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Google Calendar required</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
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
    <div className="space-y-6">
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">Working hours</h2>
          </div>

          {/* Profile tabs */}
          <div className="flex gap-2 mb-4 border-b border-outline-variant">
            <button
              type="button"
              onClick={() => setActiveTab("standard")}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
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
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === "priority"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Priority Availability
            </button>
          </div>

          <div className="space-y-3">
            {currentProfile.workingDays.map((dayConfig, idx) => (
              <div key={dayConfig.day} className="p-3 rounded-lg border border-outline-variant/50 hover:bg-surface-container-low/50 transition-colors">
                <div className="flex items-center gap-3 mb-3">
                  <input
                    type="checkbox"
                    checked={dayConfig.enabled}
                    onChange={(e) => updateDay(idx, { enabled: e.target.checked })}
                    className="w-4 h-4 cursor-pointer"
                  />
                  <label className="text-sm font-medium text-foreground flex-1 cursor-pointer">
                    {dayLabels[dayConfig.day]}
                  </label>
                </div>
                {dayConfig.enabled && (
                  <div className="grid grid-cols-2 gap-2 ml-7">
                    <div>
                      <label className="text-[11px] text-muted-foreground">Start</label>
                      <input
                        type="time"
                        value={dayConfig.startTime}
                        onChange={(e) => updateDay(idx, { startTime: e.target.value })}
                        className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">End</label>
                      <input
                        type="time"
                        value={dayConfig.endTime}
                        onChange={(e) => updateDay(idx, { endTime: e.target.value })}
                        className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">Buffer before (min)</label>
                      <input
                        type="number"
                        value={dayConfig.bufferBefore}
                        onChange={(e) => updateDay(idx, { bufferBefore: parseInt(e.target.value) || 0 })}
                        className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                        min="0"
                        step="5"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">Buffer after (min)</label>
                      <input
                        type="number"
                        value={dayConfig.bufferAfter}
                        onChange={(e) => updateDay(idx, { bufferAfter: parseInt(e.target.value) || 0 })}
                        className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                        min="0"
                        step="5"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button type="button" loading={saving} onClick={handleSaveAvailability}>
              Save availability
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Busy calendars */}
      {calendarList.length > 0 && (
        <Card variant="outlined">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-medium text-foreground">Count as busy</h3>
              {calendarTimezone && (
                <span className="text-[11px] text-muted-foreground">{calendarTimezone}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Which calendars should block time when generating availability?
            </p>
            <div className="space-y-2">
              {calendarList.map((cal) => (
                <label key={cal.id} className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={busyCalendarIds.includes(cal.id)}
                    onChange={(e) => {
                      setBusyCalendarIds(prev =>
                        e.target.checked ? [...prev, cal.id] : prev.filter(id => id !== cal.id)
                      );
                    }}
                    className="w-4 h-4 cursor-pointer"
                  />
                  <span className="text-sm text-foreground flex-1">{cal.summary || cal.id}</span>
                  <span className="text-[11px] text-muted-foreground capitalize">{cal.accessRole}</span>
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
