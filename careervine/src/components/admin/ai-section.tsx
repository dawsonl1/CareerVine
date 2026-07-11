"use client";

/**
 * Admin user-detail: AI card — key state + the fallback-policy control.
 *
 * cutoff/shared has no natural on/off, so it's a labeled radio pair (not a
 * bare toggle), with one line of copy per option so the consequence is clear.
 * Confirmed writes + toast; policy changes propagate within the resolver's
 * ≤60s cache window.
 */

import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { KeyBadge } from "@/components/admin/user-badges";
import type { AdminUserDetail } from "@/lib/admin-users";

const OPTIONS: Array<{
  value: "shared" | "cutoff";
  label: string;
  description: string;
}> = [
  {
    value: "shared",
    label: "Grant the shared key",
    description:
      "When their own key is missing, invalid, or out of quota, AI features run on CareerVine's shared key.",
  },
  {
    value: "cutoff",
    label: "Cut AI off (default)",
    description:
      "No shared fallback: AI features show a graceful “unavailable” state until they add a working key.",
  },
];

export default function AiSection({
  user,
  onChanged,
}: {
  user: AdminUserDetail;
  onChanged: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const setPolicy = async (policy: "shared" | "cutoff") => {
    if (policy === user.aiFallbackPolicy || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/ai-policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_fallback_policy: policy }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(
        policy === "shared"
          ? `${user.email ?? "Account"} now falls back to the shared key`
          : `${user.email ?? "Account"} is cut off from the shared key`,
      );
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">AI</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        How this account&apos;s OpenAI usage is handled.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Their key (last observed)
        </span>
        <KeyBadge status={user.keyStatus} />
      </div>

      <fieldset className="mt-4" disabled={saving}>
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          When their key can&apos;t be used
        </legend>
        <div className="mt-2 flex flex-col gap-2">
          {OPTIONS.map((opt) => {
            const selected = user.aiFallbackPolicy === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-outline-variant hover:bg-surface-container"
                } ${saving ? "opacity-60" : ""}`}
              >
                <input
                  type="radio"
                  name="ai-fallback-policy"
                  value={opt.value}
                  checked={selected}
                  onChange={() => void setPolicy(opt.value)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-primary,currentColor)]"
                />
                <span>
                  <span className="block text-sm font-medium text-on-surface">
                    {opt.label}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="mt-3 text-xs text-muted-foreground">
        Changes take effect within a minute.
      </p>
    </section>
  );
}
