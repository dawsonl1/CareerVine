"use client";

/**
 * Admin user-detail: Apify scraping card (plan 36 / CAR-25).
 *
 * Two kill switches next to the number they control — the account's
 * month-to-date Apify spend. Enrichment gates every paid path (auto-enrich,
 * cadence, manual refresh / find-email / resolver); diff analysis gates
 * change-event production while data still merges and snapshots.
 */

import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import type { AdminUserDetail } from "@/lib/admin-users";

const CONTROLS: Array<{
  key: "apify_enrichment_enabled" | "diff_analysis_enabled" | "discovery_enabled";
  field: "apifyEnrichmentEnabled" | "diffAnalysisEnabled" | "discoveryEnabled";
  label: string;
  description: string;
}> = [
  {
    key: "apify_enrichment_enabled",
    field: "apifyEnrichmentEnabled",
    label: "Apify enrichment",
    description:
      "All paid LinkedIn activity for this account: auto-enrich on save, the daily refresh drip, manual refresh, find-email, and profile search. Off = no new spend.",
  },
  {
    key: "diff_analysis_enabled",
    field: "diffAnalysisEnabled",
    label: "Change detection",
    description:
      "Job-change and anniversary events from refreshed profiles. Off = scraped data still lands, but no new items in their Up Next feed.",
  },
  {
    key: "discovery_enabled",
    field: "discoveryEnabled",
    label: "Discovery feed",
    description:
      "Weekly search for new PM hires at this account's target companies (~$0.10 per company page). Default off — new spend, opt in per account.",
  },
];

export default function ScrapingSection({
  user,
  monthSpendUsd,
  onChanged,
}: {
  user: AdminUserDetail;
  monthSpendUsd: number | null;
  onChanged: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const setControl = async (key: (typeof CONTROLS)[number]["key"], value: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/scrape-controls`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const label = CONTROLS.find((c) => c.key === key)?.label ?? key;
      success(`${label} ${value ? "on" : "off"} for ${user.email ?? "this account"}`);
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-on-surface">LinkedIn scraping</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Apify spend controls for this account.
          </p>
        </div>
        {monthSpendUsd != null && (
          <div className="text-right shrink-0">
            <div className="text-lg font-medium text-on-surface">${monthSpendUsd.toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">spent this month</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {CONTROLS.map((c) => (
          <div
            key={c.key}
            className="flex items-start justify-between gap-4 rounded-xl border border-outline-variant p-3"
          >
            <div>
              <div className="text-sm font-medium text-on-surface">{c.label}</div>
              <div className="text-sm text-muted-foreground">{c.description}</div>
            </div>
            <Toggle
              checked={user[c.field]}
              disabled={saving}
              onChange={(v) => void setControl(c.key, v)}
            />
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Takes effect on the next scrape or refresh — runs already in flight still finish.
      </p>
    </section>
  );
}
