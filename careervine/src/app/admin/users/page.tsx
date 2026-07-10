"use client";

/**
 * Admin users list — permissions are visible and toggleable per row (CAR-36):
 * shared-AI fallback is an inline toggle, bundle visibility lives in an
 * expandable per-row panel. Reversible writes are optimistic-with-rollback +
 * toast; destructive actions (suspend, delete, role) stay behind the detail
 * page's confirm modals.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Search,
  Loader2,
  ChevronRight,
  ChevronDown,
  Database,
  Users as UsersIcon,
} from "lucide-react";
import type { AdminUserListItem } from "@/lib/admin-users";
import type { BundleAccessItem } from "@/lib/admin-bundles";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { AdminBadge, StatusBadge, KeyBadge } from "@/components/admin/user-badges";
import BundleAccessList from "@/components/admin/bundle-access-list";

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AdminUsersPage() {
  const { success, error: toastError } = useToast();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUserListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingAiId, setSavingAiId] = useState<string | null>(null);

  // Debounced search.
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = q.trim()
          ? `/api/admin/users?q=${encodeURIComponent(q.trim())}`
          : "/api/admin/users";
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const body = (await res.json()) as { users: AdminUserListItem[] };
        setUsers(body.users);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError((e as Error).message);
        setUsers(null);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q]);

  const patchUser = (id: string, patch: Partial<AdminUserListItem>) => {
    setUsers((prev) =>
      prev ? prev.map((u) => (u.id === id ? { ...u, ...patch } : u)) : prev,
    );
  };

  /** Optimistic shared-AI flip, rolled back on failure. */
  const setAiPolicy = async (user: AdminUserListItem, share: boolean) => {
    if (savingAiId) return;
    const policy = share ? "shared" : "cutoff";
    const prevPolicy = user.aiFallbackPolicy;
    setSavingAiId(user.id);
    patchUser(user.id, { aiFallbackPolicy: policy });
    try {
      const res = await fetch(`/api/admin/users/${user.id}/ai-policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_fallback_policy: policy }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(
        share
          ? `${user.email ?? "Account"} now falls back to the shared key`
          : `${user.email ?? "Account"} is cut off from the shared key`,
      );
    } catch (err) {
      patchUser(user.id, { aiFallbackPolicy: prevPolicy });
      toastError((err as Error).message);
    } finally {
      setSavingAiId(null);
    }
  };

  /** Keep the row's n/m chip in sync with toggles inside the expander. */
  const onBundleItemsChange = (userId: string, items: BundleAccessItem[]) => {
    patchUser(userId, {
      bundlesVisible: items.filter((i) => i.visible).length,
      bundlesTotal: items.length,
    });
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[28px] leading-9 font-normal text-foreground">Users</h1>
        <p className="text-base text-muted-foreground mt-1">
          Manage accounts, access, and AI settings.
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full rounded-full border border-outline-variant bg-surface py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
      </div>

      {/* Result count */}
      {users && !loading && (
        <p className="mb-3 text-sm text-muted-foreground">
          {users.length} {users.length === 1 ? "account" : "accounts"}
          {q.trim() ? ` matching “${q.trim()}”` : ""}
        </p>
      )}

      {/* States */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading accounts…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-2xl border border-error/40 bg-error-container/40 p-6 text-center">
          <p className="text-sm text-on-error-container">Couldn’t load accounts: {error}</p>
        </div>
      )}

      {!loading && !error && users && users.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
          <UsersIcon className="h-8 w-8 opacity-50" />
          <p className="text-sm">
            {q.trim() ? `No accounts match “${q.trim()}”.` : "No accounts yet."}
          </p>
        </div>
      )}

      {!loading && !error && users && users.length > 0 && (
        <ul className="flex flex-col gap-2">
          {users.map((u) => {
            const name = `${u.firstName} ${u.lastName}`.trim() || "(no name)";
            const expanded = expandedId === u.id;
            return (
              <li
                key={u.id}
                className="rounded-2xl border border-outline-variant bg-surface"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4 sm:flex-nowrap">
                  {/* Identity — navigates to the detail page */}
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="group flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-auto"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container text-sm font-medium">
                      {(u.firstName[0] || u.email?.[0] || "U").toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-on-surface group-hover:underline">
                          {name}
                        </span>
                        {u.isAdmin && <AdminBadge />}
                        <StatusBadge status={u.status} />
                        <KeyBadge status={u.keyStatus} />
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                        <span className="truncate">{u.email ?? "—"}</span>
                        <span className="hidden lg:inline">
                          last seen {formatDate(u.lastSignInAt)}
                        </span>
                      </span>
                    </span>
                    <ChevronRight className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" />
                  </Link>

                  {/* Permissions — inline, reversible */}
                  <div className="flex shrink-0 items-center gap-2 pl-13 sm:pl-0">
                    <Tooltip
                      label={
                        u.aiFallbackPolicy === "shared"
                          ? "Falls back to CareerVine's shared key when their own key can't be used"
                          : "No shared fallback — AI is unavailable until they add a working key"
                      }
                    >
                      <span className="flex items-center gap-1.5 rounded-full border border-outline-variant px-3 py-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Shared AI
                        </span>
                        <Toggle
                          checked={u.aiFallbackPolicy === "shared"}
                          disabled={savingAiId === u.id}
                          onChange={(next) => void setAiPolicy(u, next)}
                        />
                      </span>
                    </Tooltip>

                    {u.bundlesTotal > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : u.id)}
                        aria-expanded={expanded}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                          expanded
                            ? "border-primary bg-primary/5 text-on-surface"
                            : "border-outline-variant text-muted-foreground hover:bg-surface-container"
                        }`}
                      >
                        <Database className="h-3.5 w-3.5" />
                        Bundles {u.bundlesVisible}/{u.bundlesTotal}
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      </button>
                    )}
                  </div>
                </div>

                {/* Per-bundle visibility toggles */}
                {expanded && (
                  <div className="border-t border-outline-variant px-4 pb-4 pt-1">
                    <BundleAccessList
                      userId={u.id}
                      onItemsChange={(items) => onBundleItemsChange(u.id, items)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
