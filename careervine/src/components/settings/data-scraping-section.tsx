"use client";

/**
 * Settings → Data & Scraping (plan 29 §6.6): the LinkedIn scrape system's
 * dashboard — month-to-date Apify spend against the hard cap, run health,
 * and the cadence heartbeat. Read-only: the kill switch is an env var
 * (APIFY_SCRAPE_DISABLED) and per-account auto-enrich control arrives with
 * the admin dashboard (CAR-25).
 */

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, CircleDollarSign, Activity, PauseCircle } from "lucide-react";

interface ScrapeStatus {
  configured: boolean;
  killSwitch: boolean;
  capUsd: number;
  spendUsd: number;
  pendingRuns: number;
  counts: Record<string, number>;
  lastCadenceAt: string | null;
}

export default function DataScrapingSection() {
  const [status, setStatus] = useState<ScrapeStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/scrape/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-sm text-muted-foreground py-8">Loading scrape status…</p>;
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground py-8">Couldn’t load scrape status.</p>;
  }

  const pct = Math.min(100, Math.round((status.spendUsd / status.capUsd) * 100));
  const succeeded = status.counts.succeeded ?? 0;
  const failed = (status.counts.failed ?? 0) + (status.counts.timed_out ?? 0);

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-medium text-foreground">Data & Scraping</h2>
        <p className="text-sm text-muted-foreground mt-1">
          LinkedIn profile refreshes, email discovery, and change detection run through Apify.
        </p>
      </div>

      {(!status.configured || status.killSwitch) && (
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <PauseCircle className="h-5 w-5 text-amber-600 shrink-0" />
            <p className="text-sm text-foreground">
              {status.killSwitch
                ? "Scraping is paused by the kill switch (APIFY_SCRAPE_DISABLED)."
                : "Scraping isn’t configured — set APIFY_API_TOKEN, APIFY_WEBHOOK_SECRET, and APP_BASE_URL."}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CircleDollarSign className="h-4 w-4 text-primary" />
            Monthly spend
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-medium text-foreground">${status.spendUsd.toFixed(2)}</span>
            <span className="text-sm text-muted-foreground">of ${status.capUsd.toFixed(2)} hard cap</span>
          </div>
          <div className="h-2 rounded-full bg-surface-container overflow-hidden">
            <div
              className={`h-full rounded-full ${pct >= 90 ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            When the cap is reached, automatic refreshes pause first; manual actions keep working until the hard cap.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="h-4 w-4 text-primary" />
            This month’s runs
          </div>
          <div className="flex gap-6 text-sm">
            <span className="text-foreground">{succeeded} succeeded</span>
            <span className={failed > 0 ? "text-destructive" : "text-muted-foreground"}>{failed} failed</span>
            <span className="text-muted-foreground">{status.pendingRuns} in flight</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
            {status.lastCadenceAt
              ? `Last automatic refresh: ${new Date(status.lastCadenceAt).toLocaleString()}`
              : "No automatic refresh has run yet this month."}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Contacts saved from the Chrome extension are enriched automatically (photo, employment history,
        verified email). Per-account control over auto-enrich arrives with the admin dashboard.
      </p>
    </div>
  );
}
