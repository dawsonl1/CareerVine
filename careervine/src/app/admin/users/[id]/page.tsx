"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { AdminUserDetail } from "@/lib/admin-users";
import {
  AdminBadge,
  StatusBadge,
  KeyBadge,
  PolicyBadge,
} from "@/components/admin/user-badges";
import ProfileSection from "@/components/admin/profile-section";
import SecuritySection from "@/components/admin/security-section";
import AccountSection from "@/components/admin/account-section";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-on-surface">{value || "—"}</dd>
    </div>
  );
}

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body = (await res.json()) as { user: AdminUserDetail };
      setUser(body.user);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return (
    <div>
      <Link
        href="/admin/users"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All users
      </Link>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading account…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-2xl border border-error/40 bg-error-container/40 p-6 text-center">
          <p className="text-sm text-on-error-container">{error}</p>
        </div>
      )}

      {!loading && !error && user && (
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container text-xl font-medium">
              {(user.firstName[0] || user.email?.[0] || "U").toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold text-on-surface">
                  {`${user.firstName} ${user.lastName}`.trim() || "(no name)"}
                </h1>
                {user.isAdmin && <AdminBadge />}
                <StatusBadge status={user.status} />
              </div>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>

          <ProfileSection user={user} onChanged={load} />
          <SecuritySection user={user} onChanged={load} />
          <AccountSection
            user={user}
            onChanged={load}
            onDeleted={() => router.push("/admin/users")}
          />

          <section className="rounded-2xl border border-outline-variant bg-surface p-5">
            <h2 className="text-lg font-medium text-on-surface">AI</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              How this account&apos;s OpenAI usage is handled.
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Key status" value={<KeyBadge status={user.keyStatus} />} />
              <Field
                label="Fallback policy"
                value={<PolicyBadge policy={user.aiFallbackPolicy} />}
              />
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
