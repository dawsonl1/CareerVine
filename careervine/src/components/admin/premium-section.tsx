"use client";

/**
 * Admin user-detail: the master premium (Inbox) switch (CAR-102).
 *
 * Premium = modify_scope_granted (a truthful token-fact) AND premium_enabled (this
 * switch). Turning it off moves the user to the free Outreach tier immediately, with
 * NO reconnect: the OAuth token and modify_scope_granted are untouched, the app just
 * stops using premium features. New users start free via the sensitive-only connect.
 */

import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import type { AdminUserDetail } from "@/lib/admin-users";

export default function PremiumSection({
  user,
  onChanged,
}: {
  user: AdminUserDetail;
  onChanged: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const setEnabled = async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/premium`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ premium_enabled: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(`Premium ${value ? "on" : "off"} for ${user.email ?? "this account"}`);
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Switch on, but the connection lacks the modify scope (a free-connected user or a
  // not-yet-upgraded account): premium won't take effect until they reconnect with upgrade.
  const awaitingScope = user.premiumEnabled && user.hasGmailConnection && !user.modifyScopeGranted;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-on-surface">Premium (Inbox)</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The paid live-mailbox experience. Turn off to move this account to the free Outreach tier, with no reconnect needed.
          </p>
        </div>
        <Toggle
          checked={user.premiumEnabled}
          disabled={saving || !user.hasGmailConnection}
          onChange={(v) => void setEnabled(v)}
        />
      </div>

      {!user.hasGmailConnection && (
        <p className="mt-3 text-sm text-muted-foreground">
          This account has no Gmail connection yet, so there is no tier to set.
        </p>
      )}
      {awaitingScope && (
        <p className="mt-3 text-sm text-muted-foreground">
          Premium is on, but this connection does not hold the Gmail mailbox scope yet. Ask them to open Outreach or Settings → Integrations and click &quot;Reconnect to unlock Inbox&quot; so Google can grant that scope.
        </p>
      )}
    </section>
  );
}
