"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getGmailConnection } from "@/lib/queries";
import type { GmailConnection } from "@/lib/types";
import { Mail, Check, RefreshCw, Unplug, MailCheck, Calendar } from "lucide-react";
import { OAuthWarning } from "@/components/oauth-warning";

export default function IntegrationsSection() {
  const { user } = useAuth();
  const searchParams = useSearchParams();

  // Gmail
  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  // Calendar
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarLastSynced, setCalendarLastSynced] = useState<string | null>(null);
  const [disconnectingCalendar, setDisconnectingCalendar] = useState(false);

  // Gmail OAuth result message
  const [gmailMessage, setGmailMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const gmailParam = searchParams.get("gmail");
    if (gmailParam === "connected") {
      setGmailMessage({ type: "success", text: "Gmail connected successfully!" });
    } else if (gmailParam === "error") {
      const reason = searchParams.get("reason");
      setGmailMessage({ type: "error", text: reason === "access_denied" ? "Gmail access was denied. Please try again and grant the required permissions." : `Failed to connect Gmail${reason ? `: ${reason}` : ""}. Please try again.` });
    }
  }, [searchParams]);

  const loadGmailStatus = useCallback(async () => {
    if (!user) return;
    try {
      const conn = await getGmailConnection(user.id);
      setGmailConn(conn as GmailConnection | null);
    } catch {
      // Not connected
    } finally {
      setGmailLoading(false);
    }
  }, [user]);

  const loadCalendarStatus = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/gmail/connection");
      const data = await res.json();
      if (data.connection) {
        setCalendarConnected(data.connection.calendar_scopes_granted || false);
        setCalendarLastSynced(data.connection.calendar_last_synced_at);
      }
    } catch (err) {
      console.error("Error loading calendar status:", err);
    } finally {
      setCalendarLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      loadGmailStatus();
      loadCalendarStatus();
    }
  }, [user, loadGmailStatus, loadCalendarStatus]);

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

  const handleDisconnectCalendar = async () => {
    if (!confirm("Disconnect Google Calendar?")) return;
    try {
      setDisconnectingCalendar(true);
      const res = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed to disconnect calendar");
      setCalendarConnected(false);
      setCalendarLastSynced(null);
    } catch (err) {
      console.error("Error disconnecting calendar:", err);
    } finally {
      setDisconnectingCalendar(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-6">
      {gmailMessage && (
        <div className={`p-3 rounded-xl text-sm font-medium ${gmailMessage.type === "success" ? "bg-primary-container/30 text-primary" : "bg-destructive/10 text-destructive"}`}>
          {gmailMessage.type === "success" && <Check className="h-4 w-4 inline mr-1.5" />}
          {gmailMessage.text}
        </div>
      )}

      {/* Gmail */}
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <MailCheck className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">Gmail</h2>
          </div>

          {gmailLoading ? (
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
              <span className="text-sm">Checking connection...</span>
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

              {syncResult && <p className="text-sm text-primary font-medium">{syncResult}</p>}

              <div className="flex items-center gap-3">
                <Button type="button" onClick={handleGmailSync} loading={syncing}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
                  Sync now
                </Button>
                <Button type="button" variant="text" onClick={handleGmailDisconnect} loading={disconnecting}>
                  <Unplug className="h-4 w-4 mr-2" />
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Connect your Gmail account to view email history with your contacts, send emails, and track follow-ups.
              </p>
              <OAuthWarning />
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
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">Google Calendar</h2>
          </div>

          {calendarLoading ? (
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
              <span className="text-sm">Checking connection...</span>
            </div>
          ) : calendarConnected ? (
            <div className="space-y-4">
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

              <Button type="button" variant="text" onClick={handleDisconnectCalendar} loading={disconnectingCalendar}>
                <Unplug className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Connect your Google Calendar to set your availability and schedule meetings with automatic Google Meet links.
              </p>
              <OAuthWarning />
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
    </div>
  );
}
