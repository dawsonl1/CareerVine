"use client";

/**
 * Admin user-detail: per-bundle access card.
 *
 * The toggle sets the user's effective visibility (grant/deny override); a
 * "default" hint shows when no override exists. Visibility ≠ subscription:
 * granting only lets the user SEE the bundle in Settings → Data subscriptions —
 * they still subscribe themselves. The chips make that state legible.
 *
 * Toggles are reversible, so writes here are optimistic-with-rollback + toast
 * (per the destructive-action policy, confirms are reserved for irreversible
 * actions).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, Database, RotateCcw } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import type { BundleAccessItem } from "@/lib/admin-bundles";

function StateChip({ item }: { item: BundleAccessItem }) {
  if (item.subscribed) {
    return (
      <span className="inline-flex items-center rounded-full bg-primary-container px-2 py-0.5 text-xs font-medium text-on-primary-container">
        Subscribed
      </span>
    );
  }
  if (item.visible) {
    return (
      <span className="inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-medium text-on-surface-variant">
        Can subscribe
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-medium text-on-surface-variant">
      Hidden
    </span>
  );
}

export default function BundlesSection({ userId }: { userId: string }) {
  const { success, error: toastError } = useToast();
  const [items, setItems] = useState<BundleAccessItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/bundle-access`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body = (await res.json()) as { bundles: BundleAccessItem[] };
      setItems(body.bundles);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const put = async (bundleId: number, allowed: boolean | null) => {
    const res = await fetch(`/api/admin/users/${userId}/bundle-access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleId, allowed }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
  };

  const setOverride = async (item: BundleAccessItem, allowed: boolean | null) => {
    if (!items) return;
    const prev = items;
    // Optimistic: toggles are reversible.
    setItems(
      items.map((i) =>
        i.bundleId === item.bundleId
          ? {
              ...i,
              override: allowed,
              visible: allowed === null ? i.defaultVisible : allowed,
            }
          : i,
      ),
    );
    try {
      await put(item.bundleId, allowed);
      success(
        allowed === null
          ? `${item.name}: back to default (${item.defaultVisible ? "visible" : "hidden"})`
          : allowed
            ? `Granted “${item.name}”`
            : `Hid “${item.name}”`,
      );
      void load();
    } catch (err) {
      setItems(prev);
      toastError((err as Error).message);
    }
  };

  const filtered = (items ?? []).filter(
    (i) =>
      !q.trim() ||
      i.name.toLowerCase().includes(q.trim().toLowerCase()) ||
      i.slug.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">Data bundles</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Control which bundles this account can see. Granting lets them subscribe
        from Settings — it doesn&apos;t add contacts for them.
      </p>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading bundles…</span>
        </div>
      )}

      {!loading && error && (
        <p className="py-6 text-center text-sm text-on-error-container">{error}</p>
      )}

      {!loading && !error && items && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
          <Database className="h-7 w-7 opacity-50" />
          <p className="text-sm">No published bundles yet.</p>
        </div>
      )}

      {!loading && !error && items && items.length > 0 && (
        <div className="mt-4">
          {items.length > 8 && (
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter bundles…"
                className="w-full rounded-full border border-outline-variant bg-surface py-2 pl-10 pr-4 text-sm text-on-surface placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No bundles match “{q.trim()}”.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-outline-variant">
              {filtered.map((item) => (
                <li
                  key={item.bundleId}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-on-surface">
                        {item.name}
                      </span>
                      <StateChip item={item} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.prospectCount} prospects
                      {item.override === null ? (
                        <> · default ({item.defaultVisible ? "visible" : "hidden"})</>
                      ) : (
                        <> · override: {item.override ? "granted" : "hidden"}</>
                      )}
                    </p>
                  </div>
                  {item.override !== null && (
                    <Tooltip label="Clear override (use bundle default)">
                      <button
                        type="button"
                        onClick={() => void setOverride(item, null)}
                        className="state-layer flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label={item.visible ? "Visible to this account" : "Hidden from this account"}>
                    <span>
                      <Toggle
                        checked={item.visible}
                        onChange={(next) => void setOverride(item, next)}
                      />
                    </span>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
