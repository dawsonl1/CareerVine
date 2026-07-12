"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getGmailConnection } from "@/lib/queries";
import { runFullGmailSync } from "@/lib/gmail-sync-client";
import type { GmailConnection } from "@/lib/types";
import { Mail, Check, RefreshCw, Unplug, MailCheck, Calendar } from "lucide-react";
import { OAuthWarning } from "@/components/oauth-warning";
import { useGmailConnection, invalidateGmailConnectionCache } from "@/hooks/use-gmail-connection";
import { trackBeforeNavigate } from "@/lib/analytics/client";
import McpConnectCard from "@/components/settings/mcp-connect-card";

export default function IntegrationsSection() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const { calendarConnected, calendarLastSynced, loading: calendarLoading, refresh: refreshConnection } = useGmailConnection();

  // Gmail — still uses direct Supabase query for address/sync info
  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  // Calendar disconnect
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

  useEffect(() => {
    if (user) loadGmailStatus();
  }, [user, loadGmailStatus]);

  const handleGmailSync = async () => {
    setSyncing(true);
    setSyncResult("");
    try {
      const result = await runFullGmailSync();
      setSyncResult(
        result.failedContacts > 0
          ? `Synced ${result.totalSynced} emails, ${result.failedContacts} contact${result.failedContacts === 1 ? "" : "s"} failed`
          : `Synced ${result.totalSynced} emails`
      );
      loadGmailStatus();
      setTimeout(() => setSyncResult(""), 6000);
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
      invalidateGmailConnectionCache();
      refreshConnection();
    } catch (err) {
      console.error("Error disconnecting calendar:", err);
    } finally {
      setDisconnectingCalendar(false);
    }
  };

  if (!user) return null;

  // Gmail + Calendar are the priority connections — keep the MCP card below
  // them until both are connected.
  // CAR-100: "Gmail connected" means the send scope was granted, not merely that
  // a connection row exists — the row is shared with Calendar, so a Calendar-only
  // grant (Gmail unchecked on the shared consent screen) must not read as Gmail.
  const gmailConnected = Boolean(gmailConn?.send_scope_granted);
  const bothConnected = !gmailLoading && !calendarLoading && gmailConnected && calendarConnected;

  return (
    <div className="space-y-7">
      {gmailMessage && (
        <div className={`p-4 rounded-xl text-base font-medium ${gmailMessage.type === "success" ? "bg-primary-container/30 text-primary" : "bg-destructive/10 text-destructive"}`}>
          {gmailMessage.type === "success" && <Check className="h-5 w-5 inline mr-2" />}
          {gmailMessage.text}
        </div>
      )}

      {bothConnected && <McpConnectCard />}

      {/* Gmail */}
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-6">
            <MailCheck className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Gmail</h2>
          </div>

          {gmailLoading ? (
            <div className="flex items-center gap-4 text-muted-foreground">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
              <span className="text-base">Checking connection...</span>
            </div>
          ) : gmailConn && gmailConn.send_scope_granted ? (
            <div className="space-y-5">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-primary-container/30">
                <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                  <Mail className="h-5 w-5 text-on-primary-container" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-medium text-foreground truncate">{gmailConn.gmail_address}</p>
                  <p className="text-xs text-muted-foreground">
                    {gmailConn.last_gmail_sync_at
                      ? `Last synced ${new Date(gmailConn.last_gmail_sync_at).toLocaleString()}`
                      : "Not yet synced"}
                  </p>
                </div>
              </div>

              {syncResult && <p className="text-base text-primary font-medium">{syncResult}</p>}

              <div className="flex items-center gap-4">
                <Button type="button" onClick={handleGmailSync} loading={syncing}>
                  <RefreshCw className={`h-5 w-5 mr-2 ${syncing ? "animate-spin" : ""}`} />
                  Sync now
                </Button>
                <Button type="button" variant="text" onClick={handleGmailDisconnect} loading={disconnecting}>
                  <Unplug className="h-5 w-5 mr-2" />
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-base text-muted-foreground">
                Connect Gmail to view email history with your contacts, send emails, and track follow-ups. Gmail and Google Calendar connect together on one screen.
              </p>
              <OAuthWarning />
              <Button
                href="/api/gmail/auth"
                onClick={() => trackBeforeNavigate("gmail_connect_clicked", { source: "settings" })}
              >
                <Mail className="h-5 w-5 mr-2" />
                {calendarConnected ? "Connect Gmail" : "Connect Gmail & Calendar"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Google Calendar */}
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-6">
            <Calendar className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Google Calendar</h2>
          </div>

          {calendarLoading ? (
            <div className="flex items-center gap-4 text-muted-foreground">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
              <span className="text-base">Checking connection...</span>
            </div>
          ) : calendarConnected ? (
            <div className="space-y-5">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-primary-container/30">
                <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                  <Calendar className="h-5 w-5 text-on-primary-container" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-medium text-foreground">Calendar connected</p>
                  <p className="text-xs text-muted-foreground">
                    {calendarLastSynced ? `Last synced ${new Date(calendarLastSynced).toLocaleString()}` : "Not yet synced"}
                  </p>
                </div>
              </div>

              <Button type="button" variant="text" onClick={handleDisconnectCalendar} loading={disconnectingCalendar}>
                <Unplug className="h-5 w-5 mr-2" />
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-base text-muted-foreground">
                Connect your Google Calendar to set your availability and schedule meetings with automatic Google Meet links.
              </p>
              {gmailConnected ? (
                <>
                  <OAuthWarning />
                  <Button
                    href="/api/gmail/auth"
                    onClick={() => trackBeforeNavigate("calendar_connect_clicked", { source: "settings" })}
                  >
                    <Calendar className="h-5 w-5 mr-2" />
                    Connect Google Calendar
                  </Button>
                </>
              ) : (
                // Neither connected: a single combined CTA lives on the Gmail
                // card above (one consent screen grants both) — don't add a
                // second redundant button here (CAR-100).
                <p className="text-sm text-muted-foreground/80">
                  Google Calendar connects together with Gmail. Use the Gmail connect button above.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!bothConnected && <McpConnectCard />}
    </div>
  );
}
