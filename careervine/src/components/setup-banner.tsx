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
    <div className="bg-tertiary-container border-b border-outline-variant">
      <div className="max-w-7xl mx-auto px-5 sm:px-7 lg:px-9 py-4">
        <div className="flex items-start gap-4">
          <AlertCircle className="h-6 w-6 text-on-tertiary-container shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-base font-medium text-on-tertiary-container">
              Complete your setup
            </p>
            <p className="text-sm text-on-tertiary-container/80 mt-1">
              {needsGmail && needsCalendar
                ? "Connect Gmail and Google Calendar to unlock email tracking, inbox, and meeting scheduling."
                : needsGmail
                  ? "Connect Gmail to unlock email tracking, inbox, and compose features."
                  : "Connect Google Calendar to set availability and schedule meetings."}
            </p>
            <div className="flex flex-wrap items-center gap-2.5 mt-3">
              {needsGmail && (
                <Button href="/api/gmail/auth" size="sm">
                  <Mail className="h-4 w-4 mr-2" />
                  Connect Gmail
                </Button>
              )}
              {needsCalendar && (
                <Button href="/api/gmail/auth?scopes=calendar" size="sm" variant={needsGmail ? "outline" : "primary"}>
                  <Calendar className="h-4 w-4 mr-2" />
                  Connect Calendar
                </Button>
              )}
              <button
                type="button"
                onClick={() => setShowOAuthInfo(!showOAuthInfo)}
                className="text-sm text-on-tertiary-container/70 underline underline-offset-2 hover:text-on-tertiary-container cursor-pointer"
              >
                {showOAuthInfo ? "Hide details" : "Why will Google show a warning?"}
              </button>
            </div>
            {showOAuthInfo && (
              <div className="mt-4">
                <OAuthWarning />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="p-1.5 rounded-full text-on-tertiary-container/60 hover:text-on-tertiary-container cursor-pointer shrink-0"
            title="Dismiss"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
