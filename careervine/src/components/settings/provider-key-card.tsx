"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";

type KeyStatus = {
  hasKey: boolean;
  last4?: string;
  status?: "active" | "invalid" | "quota_exceeded";
  addedAt?: string;
  lastUsedAt?: string | null;
};

/** Provider-specific copy + config for a single BYO API key card. */
export type ProviderKeyCardConfig = {
  /** Stable input id (e.g. "openai-api-key"). */
  inputId: string;
  /** Settings CRUD endpoint (e.g. "/api/settings/openai-key"). */
  endpoint: string;
  /** Card heading (e.g. "OpenAI API key"). */
  title: string;
  /** Icon rendered beside the heading. */
  icon: ReactNode;
  /** Short label used in the stored-key badge (e.g. "OpenAI key"). */
  badgeLabel: string;
  /** Input placeholder (e.g. "sk-..."). */
  placeholder: string;
  /** Intro paragraph explaining what the key is for. */
  intro: ReactNode;
  /** Ordered how-to steps. */
  steps: ReactNode;
  /** Optional setup video URL (Loom share link or direct file). */
  videoUrl?: string | null;
  /** Accessible title for the video embed. */
  videoTitle?: string;
  /** Confirm text shown before removing the key. */
  removeConfirm: string;
  /** Error shown when Save is pressed with an empty input. */
  emptyKeyError: string;
  /** Reassurance line about encryption / server-only use. */
  dataNote: ReactNode;
  /** Message for the amber "we switched to the shared key" banner. */
  problemBanner: (status: "invalid" | "quota_exceeded") => ReactNode;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isLoomUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("loom.com");
  } catch {
    return false;
  }
}

function loomEmbedUrl(url: string): string | null {
  const match = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  return `https://www.loom.com/embed/${match[1]}`;
}

function SetupVideo({ url, title }: { url?: string | null; title?: string }) {
  if (!url) return null;
  const loomEmbed = isLoomUrl(url) ? loomEmbedUrl(url) : null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-medium text-foreground mb-3">
        Watch: set up your key in 2 minutes
      </h3>
      {loomEmbed ? (
        <div className="aspect-video rounded-xl overflow-hidden border border-outline-variant">
          <iframe
            src={loomEmbed}
            allowFullScreen
            className="w-full h-full"
            title={title ?? "How to set up your API key"}
          />
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          className="w-full rounded-xl border border-outline-variant"
          src={url}
        />
      )}
    </div>
  );
}

/**
 * Generic BYO API key card: load status, paste + save (validated server-side),
 * show stored-key badge, remove. Provider differences are entirely in config.
 */
export default function ProviderKeyCard({ config }: { config: ProviderKeyCardConfig }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(config.endpoint);
      const data = await res.json();
      setStatus(data);
    } catch {
      setError("Couldn't load key status.");
    } finally {
      setLoading(false);
    }
  }, [config.endpoint]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError(config.emptyKeyError);
      return;
    }

    setError("");
    setSaved(false);
    setSaving(true);

    try {
      const res = await fetch(config.endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to save key.");
        return;
      }

      setStatus(data);
      setApiKey("");
      setSaved(true);
    } catch {
      setError("Failed to save key.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(config.removeConfirm)) {
      return;
    }

    setError("");
    setSaved(false);

    try {
      const res = await fetch(config.endpoint, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to remove key.");
        return;
      }
      setStatus(data);
      setApiKey("");
    } catch {
      setError("Failed to remove key.");
    }
  };

  const hasProblemKey =
    status?.hasKey && status.status && status.status !== "active";

  return (
    <Card variant="outlined">
      <CardContent className="p-7">
        <div className="flex items-center gap-3 mb-4">
          {config.icon}
          <h2 className="text-lg font-medium text-foreground">{config.title}</h2>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed mb-6">{config.intro}</p>

        <SetupVideo url={config.videoUrl} title={config.videoTitle} />

        <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground mb-6">
          {config.steps}
        </ol>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            {hasProblemKey && status?.status && status.status !== "active" && (
              <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <p>{config.problemBanner(status.status)}</p>
              </div>
            )}

            {status?.hasKey && (
              <div className="rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          status.status === "active" ? "bg-green-500" : "bg-amber-500"
                        }`}
                      />
                      {config.badgeLabel} •••• {status.last4}
                      {status.status !== "active" && (
                        <span className="text-xs font-normal text-muted-foreground">
                          (using shared key)
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Added {formatDate(status.addedAt)}
                      {status.lastUsedAt ? ` · Last used ${formatDate(status.lastUsedAt)}` : ""}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleRemove}>
                    Remove
                  </Button>
                </div>
              </div>
            )}

            <div>
              <label className={labelClasses} htmlFor={config.inputId}>
                {status?.hasKey ? "Replace key" : "API key"}
              </label>
              <input
                id={config.inputId}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config.placeholder}
                className={`${inputClasses} font-mono`}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
                {saving ? "Verifying…" : "Save"}
              </Button>
              {saved && <span className="text-sm text-green-600">Key saved.</span>}
              {error && <span className="text-sm text-destructive">{error}</span>}
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">{config.dataNote}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
