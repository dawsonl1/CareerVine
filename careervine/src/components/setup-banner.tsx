"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import { AlertCircle, X, Mail, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OAuthWarning } from "@/components/oauth-warning";

const DISMISSED_KEY = "setup-banner-dismissed";

/**
 * Global setup banner — shown on all pages when Gmail or Calendar is not connected.
 * Helps new users discover they need to connect integrations.
 * Dismissible per session but reappears until connected.
 */
export default function SetupBanner() {
  const { user } = useAuth();
  const { gmailConnected, gmailLoading } = useCompose();
  const { calendarConnected, loading } = useGmailConnection();
  // Read sessionStorage synchronously to avoid fetch race
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(DISMISSED_KEY) === "true" : false
  );
  const [showOAuthInfo, setShowOAuthInfo] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, "true");
  };

  // Don't render if: no user, still loading, dismissed, or everything is connected
  if (!user || loading || gmailLoading || dismissed) return null;
  if (gmailConnected && calendarConnected) return null;

  const needsGmail = !gmailConnected;
  const needsCalendar = !calendarConnected;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-3">
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
                <Button href="/api/gmail/auth" size="sm">
                  <Mail className="h-3.5 w-3.5 mr-1.5" />
                  Connect Gmail
                </Button>
              )}
              {needsCalendar && (
                <Button href="/api/gmail/auth?scopes=calendar" size="sm" variant={needsGmail ? "outline" : "primary"}>
                  <Calendar className="h-3.5 w-3.5 mr-1.5" />
                  Connect Calendar
                </Button>
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
              <div className="mt-3">
                <OAuthWarning variant="amber" />
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
