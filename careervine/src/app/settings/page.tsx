/**
 * Settings page — user profile and account management
 *
 * Two sections:
 *   1. Profile: edit first_name, last_name, phone (saved to public.users table)
 *   2. Change password: new password + confirm, uses supabase.auth.updateUser()
 *
 * Data flow:
 *   Load: getUserProfile(userId) → populate form
 *   Save: updateUserProfile(userId, updates)
 *   Password: createSupabaseBrowserClient().auth.updateUser({ password })
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getUserProfile, updateUserProfile, getGmailConnection } from "@/lib/queries";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { GmailConnection, EmailTemplate } from "@/lib/types";
import { User, Phone, Mail, Check, Lock, RefreshCw, Unplug, MailCheck, Sparkles, Plus, Pencil, Trash2, X, Calendar, ChevronDown } from "lucide-react";

const inputClasses =
  "w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm";
const labelClasses = "block text-xs font-medium text-muted-foreground mb-1.5";

export default function SettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Password change
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Gmail
  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  // Email templates
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<{ id?: number; name: string; prompt: string } | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateError, setTemplateError] = useState("");

  // Calendar
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarLastSynced, setCalendarLastSynced] = useState<string | null>(null);
  const [disconnectingCalendar, setDisconnectingCalendar] = useState(false);
  const [activeAvailabilityTab, setActiveAvailabilityTab] = useState<"standard" | "priority">("standard");
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [calendarList, setCalendarList] = useState<Array<{ id: string; summary: string; accessRole: string }>>([]);
  const [busyCalendarIds, setBusyCalendarIds] = useState<string[]>(["primary"]);
  const [savingBusyCalendars, setSavingBusyCalendars] = useState(false);
  const [calendarTimezone, setCalendarTimezone] = useState("");

  // Per-day working times (Monday-Sunday)
  const dayLabels = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const [availabilityStandard, setAvailabilityStandard] = useState({
    workingDays: [
      { day: 0, enabled: true, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 1, enabled: true, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 2, enabled: true, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 3, enabled: true, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 4, enabled: true, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 5, enabled: false, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
      { day: 6, enabled: false, startTime: "09:00", endTime: "18:00", bufferBefore: 10, bufferAfter: 10 },
    ],
  });
  const [availabilityPriority, setAvailabilityPriority] = useState({
    workingDays: [
      { day: 0, enabled: true, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 1, enabled: true, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 2, enabled: true, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 3, enabled: true, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 4, enabled: true, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 5, enabled: false, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
      { day: 6, enabled: false, startTime: "09:00", endTime: "17:00", bufferBefore: 15, bufferAfter: 15 },
    ],
  });

  useEffect(() => {
    if (user) {
      loadProfile();
      loadGmailStatus();
      loadTemplates();
      loadCalendarStatus();
    }
  }, [user]);

  const loadCalendarStatus = async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/gmail/connection");
      const data = await res.json();
      if (data.connection) {
        setCalendarConnected(data.connection.calendar_scopes_granted || false);
        setCalendarLastSynced(data.connection.calendar_last_synced_at);
        if (data.connection.availability_standard) {
          setAvailabilityStandard(data.connection.availability_standard);
        }
        if (data.connection.availability_priority) {
          setAvailabilityPriority(data.connection.availability_priority);
        }
        if (data.connection.calendar_list) {
          setCalendarList(data.connection.calendar_list);
        }
        if (data.connection.busy_calendar_ids) {
          setBusyCalendarIds(data.connection.busy_calendar_ids);
        }
        if (data.connection.calendar_timezone) {
          setCalendarTimezone(data.connection.calendar_timezone);
        }
      }
    } catch (err) {
      console.error("Error loading calendar status:", err);
    } finally {
      setCalendarLoading(false);
    }
  };

  const loadProfile = async () => {
    if (!user) return;
    try {
      const profile = await getUserProfile(user.id);
      setFirstName(profile.first_name || "");
      setLastName(profile.last_name || "");
      setPhone(profile.phone || "");
    } catch (err) {
      console.error("Error loading profile:", err);
    } finally {
      setLoading(false);
    }
  };

  const loadGmailStatus = async () => {
    if (!user) return;
    try {
      const conn = await getGmailConnection(user.id);
      setGmailConn(conn as GmailConnection | null);
    } catch {
      // Not connected — that's fine
    } finally {
      setGmailLoading(false);
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch("/api/gmail/templates");
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch {
      // ignore
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return;
    if (!editingTemplate.name.trim() || !editingTemplate.prompt.trim()) {
      setTemplateError("Name and prompt are both required.");
      return;
    }
    setTemplateError("");
    setTemplateSaving(true);
    try {
      const res = await fetch("/api/gmail/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingTemplate.id || undefined,
          name: editingTemplate.name.trim(),
          prompt: editingTemplate.prompt.trim(),
          sort_order: templates.length,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setEditingTemplate(null);
      loadTemplates();
    } catch {
      setTemplateError("Failed to save template.");
    } finally {
      setTemplateSaving(false);
    }
  };

  const handleSaveAvailability = async () => {
    try {
      setSavingAvailability(true);
      const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
      const res = await fetch("/api/calendar/availability-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: activeAvailabilityTab,
          data: profile,
        }),
      });
      if (!res.ok) throw new Error("Failed to save availability");
      setError("");
    } catch (err) {
      console.error("Error saving availability:", err);
      setError(err instanceof Error ? err.message : "Failed to save availability");
    } finally {
      setSavingAvailability(false);
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

  const handleDisconnectCalendar = async () => {
    try {
      setDisconnectingCalendar(true);
      const res = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed to disconnect calendar");
      setCalendarConnected(false);
      setCalendarLastSynced(null);
    } catch (err) {
      console.error("Error disconnecting calendar:", err);
      setError(err instanceof Error ? err.message : "Failed to disconnect calendar");
    } finally {
      setDisconnectingCalendar(false);
    }
  };

  const handleDeleteTemplate = async (id: number) => {
    if (!confirm("Delete this template?")) return;
    try {
      await fetch(`/api/gmail/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // ignore
    }
  };

  const handleGmailSync = async () => {
    setSyncing(true);
    setSyncResult("");
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSyncResult(`Synced ${data.totalSynced} emails`);
      loadGmailStatus();
      setTimeout(() => setSyncResult(""), 4000);
    } catch (err) {
      setSyncResult(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleGmailDisconnect = async () => {
    if (!confirm("Disconnect Gmail? This will remove all cached email data.")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/gmail/disconnect", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      setGmailConn(null);
    } catch (err) {
      console.error("Disconnect error:", err);
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError("");
    setSaving(true);
    try {
      await updateUserProfile(user.id, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      console.error("Error saving profile:", err);
      setError("Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading profile…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-8">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your profile</p>
        </div>

        <Card variant="outlined">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-lg font-medium">
                {(firstName?.[0] || user.email?.[0] || "U").toUpperCase()}
              </div>
              <div>
                <p className="text-base font-medium text-foreground">
                  {firstName || lastName ? `${firstName} ${lastName}`.trim() : "Your profile"}
                </p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClasses}>
                    <span className="inline-flex items-center gap-1"><User className="h-3 w-3" /> First name</span>
                  </label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className={inputClasses}
                    placeholder="First name"
                    required
                  />
                </div>
                <div>
                  <label className={labelClasses}>Last name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className={inputClasses}
                    placeholder="Last name"
                    required
                  />
                </div>
              </div>

              <div>
                <label className={labelClasses}>
                  <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> Email</span>
                </label>
                <input
                  type="email"
                  value={user.email || ""}
                  disabled
                  className={`${inputClasses} opacity-50 cursor-not-allowed`}
                />
                <p className="text-[11px] text-muted-foreground mt-1">Email is managed through authentication and cannot be changed here.</p>
              </div>

              <div>
                <label className={labelClasses}>
                  <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> Phone</span>
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClasses}
                  placeholder="555-123-4567 (optional)"
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button type="submit" loading={saving}>
                  Save changes
                </Button>
                {saved && (
                  <span className="inline-flex items-center gap-1 text-sm text-primary font-medium animate-pulse">
                    <Check className="h-4 w-4" /> Saved
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
        {/* Change password */}
        <Card variant="outlined" className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-5">
              <Lock className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Change password</h2>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              setPasswordError("");
              if (newPassword.length < 6) {
                setPasswordError("Password must be at least 6 characters.");
                return;
              }
              if (newPassword !== confirmPassword) {
                setPasswordError("Passwords do not match.");
                return;
              }
              setPasswordSaving(true);
              try {
                const supabase = createSupabaseBrowserClient();
                const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
                if (pwErr) throw pwErr;
                setNewPassword("");
                setConfirmPassword("");
                setPasswordSaved(true);
                setTimeout(() => setPasswordSaved(false), 2500);
              } catch (err: unknown) {
                console.error("Error changing password:", err);
                setPasswordError(err instanceof Error ? err.message : "Failed to change password.");
              } finally {
                setPasswordSaving(false);
              }
            }} className="space-y-4">
              <div>
                <label className={labelClasses}>New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputClasses}
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                />
              </div>
              <div>
                <label className={labelClasses}>Confirm new password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClasses}
                  placeholder="Re-enter new password"
                  required
                />
              </div>

              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button type="submit" loading={passwordSaving}>
                  Update password
                </Button>
                {passwordSaved && (
                  <span className="inline-flex items-center gap-1 text-sm text-primary font-medium animate-pulse">
                    <Check className="h-4 w-4" /> Password updated
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
        {/* Email integration */}
        <Card variant="outlined" className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-5">
              <MailCheck className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Email integration</h2>
            </div>

            {gmailLoading ? (
              <div className="flex items-center gap-3 text-muted-foreground">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
                <span className="text-sm">Checking connection…</span>
              </div>
            ) : gmailConn ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary-container/30">
                  <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center">
                    <Mail className="h-4 w-4 text-on-primary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{gmailConn.gmail_address}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {gmailConn.last_gmail_sync_at
                        ? `Last synced ${new Date(gmailConn.last_gmail_sync_at).toLocaleString()}`
                        : "Not yet synced"}
                    </p>
                  </div>
                </div>

                {syncResult && (
                  <p className="text-sm text-primary font-medium">{syncResult}</p>
                )}

                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    onClick={handleGmailSync}
                    loading={syncing}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
                    Sync now
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    onClick={handleGmailDisconnect}
                    loading={disconnecting}
                  >
                    <Unplug className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Connect your Gmail account to view email history with your contacts.
                </p>
                <a href="/api/gmail/auth">
                  <Button type="button">
                    <Mail className="h-4 w-4 mr-2" />
                    Connect Gmail
                  </Button>
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Google Calendar */}
        <Card variant="outlined" className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-5">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Availability</h2>
            </div>

            {calendarLoading ? (
              <div className="flex items-center gap-3 text-muted-foreground">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                <span className="text-sm">Loading availability…</span>
              </div>
            ) : calendarConnected ? (
              <div className="space-y-6">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary-container/30">
                  <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center">
                    <Calendar className="h-4 w-4 text-on-primary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Calendar connected</p>
                    <p className="text-[11px] text-muted-foreground">
                      {calendarLastSynced ? `Last synced ${new Date(calendarLastSynced).toLocaleString()}` : "Not yet synced"}
                    </p>
                  </div>
                </div>

                {/* Availability profiles with per-day working times */}
                <div>
                  <div className="flex gap-2 mb-4 border-b border-outline-variant">
                    <button
                      type="button"
                      onClick={() => setActiveAvailabilityTab("standard")}
                      className={`px-3 py-2 text-xs font-medium transition-colors ${
                        activeAvailabilityTab === "standard"
                          ? "text-primary border-b-2 border-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Standard Availability
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveAvailabilityTab("priority")}
                      className={`px-3 py-2 text-xs font-medium transition-colors ${
                        activeAvailabilityTab === "priority"
                          ? "text-primary border-b-2 border-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Priority Availability
                    </button>
                  </div>

                  <div className="space-y-3">
                    {(activeAvailabilityTab === "standard" ? availabilityStandard.workingDays : availabilityPriority.workingDays).map((dayConfig, idx) => (
                      <div key={dayConfig.day} className="p-3 rounded-lg border border-outline-variant/50 hover:bg-surface-container-low/50 transition-colors">
                        <div className="flex items-center gap-3 mb-3">
                          <input
                            type="checkbox"
                            checked={dayConfig.enabled}
                            onChange={(e) => {
                              const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
                              const updated = {
                                ...profile,
                                workingDays: profile.workingDays.map((d, i) =>
                                  i === idx ? { ...d, enabled: e.target.checked } : d
                                ),
                              };
                              if (activeAvailabilityTab === "standard") {
                                setAvailabilityStandard(updated);
                              } else {
                                setAvailabilityPriority(updated);
                              }
                            }}
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
                                onChange={(e) => {
                                  const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
                                  const updated = {
                                    ...profile,
                                    workingDays: profile.workingDays.map((d, i) =>
                                      i === idx ? { ...d, startTime: e.target.value } : d
                                    ),
                                  };
                                  if (activeAvailabilityTab === "standard") {
                                    setAvailabilityStandard(updated);
                                  } else {
                                    setAvailabilityPriority(updated);
                                  }
                                }}
                                className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground">End</label>
                              <input
                                type="time"
                                value={dayConfig.endTime}
                                onChange={(e) => {
                                  const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
                                  const updated = {
                                    ...profile,
                                    workingDays: profile.workingDays.map((d, i) =>
                                      i === idx ? { ...d, endTime: e.target.value } : d
                                    ),
                                  };
                                  if (activeAvailabilityTab === "standard") {
                                    setAvailabilityStandard(updated);
                                  } else {
                                    setAvailabilityPriority(updated);
                                  }
                                }}
                                className="w-full h-8 px-2 bg-surface-container-low text-foreground rounded text-xs border border-outline"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground">Buffer before (min)</label>
                              <input
                                type="number"
                                value={dayConfig.bufferBefore}
                                onChange={(e) => {
                                  const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
                                  const updated = {
                                    ...profile,
                                    workingDays: profile.workingDays.map((d, i) =>
                                      i === idx ? { ...d, bufferBefore: parseInt(e.target.value) || 0 } : d
                                    ),
                                  };
                                  if (activeAvailabilityTab === "standard") {
                                    setAvailabilityStandard(updated);
                                  } else {
                                    setAvailabilityPriority(updated);
                                  }
                                }}
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
                                onChange={(e) => {
                                  const profile = activeAvailabilityTab === "standard" ? availabilityStandard : availabilityPriority;
                                  const updated = {
                                    ...profile,
                                    workingDays: profile.workingDays.map((d, i) =>
                                      i === idx ? { ...d, bufferAfter: parseInt(e.target.value) || 0 } : d
                                    ),
                                  };
                                  if (activeAvailabilityTab === "standard") {
                                    setAvailabilityStandard(updated);
                                  } else {
                                    setAvailabilityPriority(updated);
                                  }
                                }}
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
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button type="button" loading={savingAvailability} onClick={handleSaveAvailability}>
                    Save availability
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    onClick={handleDisconnectCalendar}
                    loading={disconnectingCalendar}
                  >
                    <Unplug className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                </div>

                {/* Which calendars count as busy */}
                {calendarList.length > 0 && (
                  <div className="mt-6 pt-6 border-t border-outline-variant/50">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-medium text-foreground">Count as busy</h3>
                      {calendarTimezone && (
                        <span className="text-[11px] text-muted-foreground">{calendarTimezone}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
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
                                e.target.checked
                                  ? [...prev, cal.id]
                                  : prev.filter(id => id !== cal.id)
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
                      className="mt-3"
                      loading={savingBusyCalendars}
                      onClick={handleSaveBusyCalendars}
                    >
                      Save calendar selection
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Connect your Google Calendar to set your availability and schedule meetings with automatic Google Meet links.
                </p>
                <a href="/api/gmail/auth?scopes=calendar">
                  <Button type="button">
                    <Calendar className="h-4 w-4 mr-2" />
                    Connect Google Calendar
                  </Button>
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Email AI templates */}
        <Card variant="outlined" className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">AI email templates</h2>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditingTemplate({ name: "", prompt: "" })}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                New template
              </Button>
            </div>

            <p className="text-xs text-muted-foreground mb-4">
              Create custom templates for the &quot;Write with AI&quot; feature in the compose window. Your templates appear alongside the built-in presets.
            </p>

            {/* Template editor */}
            {editingTemplate && (
              <div className="mb-4 p-4 rounded-xl bg-surface-container-low border border-outline-variant">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-foreground">
                    {editingTemplate.id ? "Edit template" : "New template"}
                  </p>
                  <button
                    type="button"
                    onClick={() => { setEditingTemplate(null); setTemplateError(""); }}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={labelClasses}>Template name</label>
                    <input
                      type="text"
                      value={editingTemplate.name}
                      onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                      className={inputClasses}
                      placeholder='e.g., "Job referral request"'
                    />
                  </div>
                  <div>
                    <label className={labelClasses}>Prompt / instructions for AI</label>
                    <textarea
                      value={editingTemplate.prompt}
                      onChange={(e) => setEditingTemplate({ ...editingTemplate, prompt: e.target.value })}
                      className="w-full h-24 px-4 py-3 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm resize-none"
                      placeholder='e.g., "Write a professional email requesting a referral for a position at their company. Mention my relevant experience and express enthusiasm for the role."'
                    />
                  </div>
                  {templateError && <p className="text-sm text-destructive">{templateError}</p>}
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" onClick={handleSaveTemplate} loading={templateSaving}>
                      {editingTemplate.id ? "Save changes" : "Create template"}
                    </Button>
                    <Button type="button" variant="text" size="sm" onClick={() => { setEditingTemplate(null); setTemplateError(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Template list */}
            {templatesLoading ? (
              <div className="flex items-center gap-3 text-muted-foreground">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
                <span className="text-sm">Loading templates…</span>
              </div>
            ) : templates.length === 0 ? (
              <div className="text-center py-6">
                <Sparkles className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No custom templates yet.</p>
                <p className="text-xs text-muted-foreground mt-1">Built-in presets (Introduction, Follow-up, Thank you, etc.) are always available.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <div key={t.id} className="flex items-start gap-3 p-3 rounded-lg border border-outline-variant/50 hover:bg-surface-container-low/50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{t.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.prompt}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEditingTemplate({ id: t.id, name: t.name, prompt: t.prompt })}
                        className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTemplate(t.id)}
                        className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
