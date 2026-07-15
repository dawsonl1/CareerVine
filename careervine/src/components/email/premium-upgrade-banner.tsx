"use client";

/**
 * Shown when capability `inbox:upgrade` is present: Premium is on but the
 * Gmail token still lacks gmail.modify. Reconnect with ?upgrade=1 to request it.
 */

import { Button } from "@/components/ui/button";
import { MailCheck } from "lucide-react";
import { trackBeforeNavigate } from "@/lib/analytics/client";

const UPGRADE_HREF = "/api/gmail/auth?upgrade=1&returnTo=/inbox";

export function PremiumUpgradeBanner({ source }: { source: "outreach" | "settings" }) {
  return (
    <div className="rounded-xl border border-primary/30 bg-primary-container/25 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-medium text-on-surface">Unlock Inbox</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Premium is on for your account. Reconnect Gmail once to grant the mailbox scope for live inbox, reply detection, and bounce handling.
          </p>
        </div>
        <Button
          href={UPGRADE_HREF}
          className="shrink-0"
          onClick={() => trackBeforeNavigate("gmail_connect_clicked", { source })}
        >
          <MailCheck className="h-5 w-5 mr-2" />
          Reconnect to unlock Inbox
        </Button>
      </div>
    </div>
  );
}
