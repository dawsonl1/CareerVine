"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LoadErrorState } from "@/components/ui/load-error-state";
import { apiFetch, isApiRequestError, jsonBody } from "@/lib/api-client";

export type KeyStatus = {
  hasKey: boolean;
  last4?: string;
  status?: "active" | "invalid" | "quota_exceeded";
  addedAt?: string;
  lastUsedAt?: string | null;
  /** Whether this account may use CareerVine's shared key (CAR-26; OpenAI only). */
  sharedAccess?: boolean;
  /** 24h shared-AI trial state (CAR-51; OpenAI only). Null = not a trial account. */
  trialState?: "active" | "expired" | null;
  /** When the active trial ends (CAR-51). */
  sharedAccessExpiresAt?: string | null;
  /** When the user last requested continued access (CAR-51). */
  accessRequestedAt?: string | null;
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
  /** Intro paragraph explaining what the key is for. A function form receives
   * the loaded key status (null while loading) so copy can adapt — e.g. the
   * OpenAI intro reads differently when the account has no shared-key access. */
  intro: ReactNode | ((status: KeyStatus | null) => ReactNode);
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
  /** Message for the amber problem-key banner. Receives the full key status as
   * a second arg so copy can adapt to shared-key entitlement (CAR-26). */
  problemBanner: (status: "invalid" | "quota_exceeded", keyStatus: KeyStatus) => ReactNode;
  /** Optional banner above the key controls, driven by the loaded status —
   * the CAR-51 trial note / locked state slot. Return null to render nothing. */
  statusBanner?: (keyStatus: KeyStatus) => ReactNode;
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
  const { confirm, confirmDialog } = useConfirm();
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      // Unchecked, a non-2xx `{ error }` body was assigned straight to `status`,
      // where `hasKey` reads undefined and the card renders its no-key state:
      // the user is told they have no key on file when the read simply failed,
      // and pastes a replacement over a key that was there all along (CAR-188).
      setStatus(await apiFetch<KeyStatus>(config.endpoint));
      setLoadFailed(false);
    } catch {
      // Not an inline `error` beside Save: that leaves the whole key form live,
      // which is the overwrite hazard above. The controls are withheld until a
      // read succeeds and we know what is actually stored.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [config.endpoint]);

  useEffect(() => {
    // Fire-and-forget: loadStatus catches its own errors into `error`.
    void loadStatus();
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
      // This is one of the few sites that SHOULD surface the route's own
      // message: the endpoint validates the key against the provider, so
      // "That key was rejected by OpenAI" is the whole answer the user needs.
      // `ApiRequestError.message` is exactly the `data.error` this used to read
      // by hand, with the missing-or-unparseable-body fallback handled.
      setStatus(await apiFetch<KeyStatus>(config.endpoint, jsonBody({ apiKey: apiKey.trim() }, "PUT")));
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(isApiRequestError(err) ? err.message : "Failed to save key.");
    } finally {
      setSaving(false);
    }
  };

  // reentry-safe: useConfirm() supersedes a pending question synchronously, so a second click resolves the first false and returns before the DELETE
  const handleRemove = async () => {
    // The only one of the twelve confirms whose copy is not a string literal:
    // it comes from the per-provider config, which is why ConfirmDialog takes a
    // `message` prop rather than owning its own wording (CAR-188).
    if (!(await confirm({
      message: config.removeConfirm,
      title: "Remove key",
      confirmLabel: "Remove",
      destructive: true,
    }))) {
      return;
    }

    setError("");
    setSaved(false);

    try {
      setStatus(await apiFetch<KeyStatus>(config.endpoint, { method: "DELETE" }));
      setApiKey("");
    } catch (err) {
      setError(isApiRequestError(err) ? err.message : "Failed to remove key.");
    }
  };

  const hasProblemKey =
    status?.hasKey && status.status && status.status !== "active";

  return (
    <>
    <Card variant="outlined">
      <CardContent className="p-7">
        <div className="flex items-center gap-3 mb-4">
          {config.icon}
          <h2 className="text-lg font-medium text-foreground">{config.title}</h2>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          {typeof config.intro === "function" ? config.intro(status) : config.intro}
        </p>

        <SetupVideo url={config.videoUrl} title={config.videoTitle} />

        <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground mb-6">
          {config.steps}
        </ol>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : loadFailed ? (
          <LoadErrorState
            message="Couldn't load your key status."
            onRetry={() => { setLoading(true); void loadStatus(); }}
          />
        ) : (
          <div className="space-y-4">
            {status && config.statusBanner?.(status)}

            {hasProblemKey && status?.status && status.status !== "active" && (
              <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <p>{config.problemBanner(status.status, status)}</p>
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
    {confirmDialog}
    </>
  );
}
