"use client";

/**
 * Admin user-detail: automatic-features entitlement (CAR-103).
 *
 * Grants the paid automatic reply-detection + bounce-cancel by flipping
 * automatic_features_enabled on the user's gmail_connections row. The capability
 * resolver reads it (followups:auto needs both this grant and the gmail.modify
 * scope). Free accounts confirm follow-ups manually instead.
 */

import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import type { AdminUserDetail } from "@/lib/admin-users";

export default function AutomaticFeaturesSection({
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
      const res = await fetch(`/api/admin/users/${user.id}/automatic-features`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ automatic_features_enabled: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(`Automatic features ${value ? "on" : "off"} for ${user.email ?? "this account"}`);
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const awaitingReconnect = user.automaticFeaturesEnabled && !user.modifyScopeGranted;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-on-surface">Automatic features</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Paid tier: automatic reply-detection and bounce-cancel. Free accounts confirm follow-ups manually.
          </p>
        </div>
        <Toggle
          checked={user.automaticFeaturesEnabled}
          disabled={saving || !user.hasGmailConnection}
          onChange={(v) => void setEnabled(v)}
        />
      </div>

      {!user.hasGmailConnection && (
        <p className="mt-3 text-sm text-muted-foreground">
          This account has no Gmail connection yet, so there is nothing to automate.
        </p>
      )}
      {awaitingReconnect && (
        <p className="mt-3 text-sm text-muted-foreground">
          Entitled, but this connection does not hold the required Gmail scope yet. The automatic features activate once they reconnect.
        </p>
      )}
    </section>
  );
}
