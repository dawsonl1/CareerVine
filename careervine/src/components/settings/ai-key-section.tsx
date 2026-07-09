"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, AlertTriangle } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import AiKeyVideo from "@/components/settings/ai-key-video";

type KeyStatus = {
  hasKey: boolean;
  last4?: string;
  status?: "active" | "invalid" | "quota_exceeded";
  addedAt?: string;
  lastUsedAt?: string | null;
  /** Whether this account is entitled to CareerVine's shared key (CAR-26). */
  sharedAccess?: boolean;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function AiKeySection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/openai-key");
      const data = await res.json();
      setStatus(data);
    } catch {
      setError("Couldn't load key status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError("Paste your OpenAI API key first.");
      return;
    }

    setError("");
    setSaved(false);
    setSaving(true);

    try {
      const res = await fetch("/api/settings/openai-key", {
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
    if (!window.confirm("Remove your OpenAI key? AI features will use CareerVine's shared key instead.")) {
      return;
    }

    setError("");
    setSaved(false);

    try {
      const res = await fetch("/api/settings/openai-key", { method: "DELETE" });
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
          <Bot className="h-6 w-6 text-muted-foreground" />
          <h2 className="text-lg font-medium text-foreground">OpenAI API key</h2>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          {status && !status.hasKey && !status.sharedAccess ? (
            <>
              CareerVine&apos;s AI features — email drafts, transcript parsing, follow-up suggestions — run on an OpenAI key. Add your own below to turn them on. With OpenAI&apos;s free daily tokens, most people pay nothing.
            </>
          ) : (
            <>
              Add your own OpenAI key to run CareerVine&apos;s AI features on your account{status?.sharedAccess ? " instead of our shared key" : ""}. With OpenAI&apos;s free daily tokens, most people pay nothing.
            </>
          )}
        </p>

        <AiKeyVideo />

        <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground mb-6">
          <li>
            Go to{" "}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              platform.openai.com/api-keys
            </a>{" "}
            and sign in (or create an account — no payment method needed for free-tier usage).
          </li>
          <li>Click <strong className="text-foreground font-medium">Create new secret key</strong>, name it &quot;CareerVine&quot;, leave permissions on <strong className="text-foreground font-medium">All</strong>, create.</li>
          <li>Copy the key immediately — OpenAI only shows it once.</li>
          <li>
            <em>(For free daily tokens)</em> Go to <strong className="text-foreground font-medium">Settings → Data controls → Sharing</strong> and turn on <strong className="text-foreground font-medium">&quot;Share inputs and outputs with OpenAI&quot;</strong> — this gives your account up to 250k free tokens/day on the models CareerVine uses.{" "}
            <em>Heads-up: this shares your CareerVine prompts — which can include contact names and conversation content — with OpenAI for model training. If you&apos;d rather not, skip this step and add a few dollars of credit instead.</em>
          </li>
          <li>Paste the key below and hit Save.</li>
        </ol>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            {hasProblemKey && (
              <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <p>
                  {status.status === "quota_exceeded"
                    ? "Your key has run out of quota."
                    : "Your key was rejected by OpenAI."}{" "}
                  We&apos;ve switched you back to CareerVine&apos;s shared key. Paste a new key or check your OpenAI billing.
                </p>
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
                      OpenAI key •••• {status.last4}
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
              <label className={labelClasses} htmlFor="openai-api-key">
                {status?.hasKey ? "Replace key" : "API key"}
              </label>
              <input
                id="openai-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
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

            <p className="text-xs text-muted-foreground leading-relaxed">
              Your key is encrypted before it&apos;s stored and is never sent to your browser or anyone else. It&apos;s only used server-side to talk to OpenAI on your behalf. Remove it anytime.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
