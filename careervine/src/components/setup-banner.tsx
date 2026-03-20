"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import { AlertCircle, X, Mail, Calendar, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Global setup banner — shown on all pages when Gmail or Calendar is not connected.
 * Helps new users discover they need to connect integrations.
 * Dismissible per session but reappears until connected.
 */
export default function SetupBanner() {
  const { user } = useAuth();
  const { gmailConnected } = useCompose();
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showOAuthInfo, setShowOAuthInfo] = useState(false);

  useEffect(() => {
    if (!user) return;
    const checkCalendar = async () => {
      try {
        const res = await fetch("/api/gmail/connection");
        const data = await res.json();
        setCalendarConnected(data.connection?.calendar_scopes_granted || false);
      } catch {
        setCalendarConnected(false);
      }
    };
    checkCalendar();
  }, [user]);

  // Check session dismissal
  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(sessionStorage.getItem("setup-banner-dismissed") === "true");
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem("setup-banner-dismissed", "true");
  };

  // Don't render if: no user, still loading, dismissed, or everything is connected
  if (!user || calendarConnected === null || dismissed) return null;
  if (gmailConnected && calendarConnected) return null;

  const needsGmail = !gmailConnected;
  const needsCalendar = !calendarConnected;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Complete your setup
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {needsGmail && needsCalendar
                ? "Connect Gmail and Google Calendar to unlock email tracking, inbox, and meeting scheduling."
                : needsGmail
                  ? "Connect Gmail to unlock email tracking, inbox, and compose features."
                  : "Connect Google Calendar to set availability and schedule meetings."}
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2.5">
              {needsGmail && (
                <a href="/api/gmail/auth">
                  <Button type="button" size="sm">
                    <Mail className="h-3.5 w-3.5 mr-1.5" />
                    Connect Gmail
                  </Button>
                </a>
              )}
              {needsCalendar && (
                <a href="/api/gmail/auth?scopes=calendar">
                  <Button type="button" size="sm" variant={needsGmail ? "outline" : "primary"}>
                    <Calendar className="h-3.5 w-3.5 mr-1.5" />
                    Connect Calendar
                  </Button>
                </a>
              )}
              <button
                type="button"
                onClick={() => setShowOAuthInfo(!showOAuthInfo)}
                className="text-xs text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 cursor-pointer"
              >
                {showOAuthInfo ? "Hide details" : "Why will Google show a warning?"}
              </button>
            </div>
            {showOAuthInfo && (
              <div className="flex gap-2.5 mt-3 p-2.5 rounded-lg bg-amber-100/60 dark:bg-amber-900/30">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  CareerVine is in the Google verification process. You&apos;ll see a &quot;This app isn&apos;t verified&quot; screen.
                  Click <strong>&quot;Advanced&quot;</strong> then <strong>&quot;Go to CareerVine (unsafe)&quot;</strong> to continue.
                  Your data is only used within your CareerVine account.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="p-1 rounded-full text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 cursor-pointer shrink-0"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
