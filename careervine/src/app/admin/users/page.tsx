"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Loader2, ChevronRight, Users as UsersIcon } from "lucide-react";
import type { AdminUserListItem } from "@/lib/admin-users";
import {
  AdminBadge,
  StatusBadge,
  KeyBadge,
  PolicyBadge,
} from "@/components/admin/user-badges";

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AdminUsersPage() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUserListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            return (
              <li key={u.id}>
                <Link
                  href={`/admin/users/${u.id}`}
                  className="flex items-center gap-3 rounded-2xl border border-outline-variant bg-surface p-4 transition-colors hover:bg-surface-container"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container text-sm font-medium">
                    {(u.firstName[0] || u.email?.[0] || "U").toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-on-surface">{name}</span>
                      {u.isAdmin && <AdminBadge />}
                      <StatusBadge status={u.status} />
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <span className="truncate">{u.email ?? "—"}</span>
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-2 sm:flex">
                    <KeyBadge status={u.keyStatus} />
                    <PolicyBadge policy={u.aiFallbackPolicy} />
                  </span>
                  <span className="hidden shrink-0 text-right text-xs text-muted-foreground md:block">
                    <span className="block">last seen</span>
                    <span>{formatDate(u.lastSignInAt)}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
