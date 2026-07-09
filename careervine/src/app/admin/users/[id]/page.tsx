"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { AdminUserDetail } from "@/lib/admin-users";
import {
  AdminBadge,
  StatusBadge,
  KeyBadge,
  PolicyBadge,
} from "@/components/admin/user-badges";

function formatDateTime(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

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

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">{title}</h2>
      {description && (
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/users/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const body = (await res.json()) as { user: AdminUserDetail };
        if (active) setUser(body.user);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

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

          <SectionCard title="Profile">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="First name" value={user.firstName} />
              <Field label="Last name" value={user.lastName} />
              <Field label="Email" value={user.email} />
              <Field label="Phone" value={user.phone} />
            </dl>
          </SectionCard>

          <SectionCard title="Account">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Status"
                value={user.status === "suspended" ? "Suspended" : "Active"}
              />
              <Field label="Role" value={user.isAdmin ? "Admin" : "Member"} />
              <Field label="Created" value={formatDateTime(user.createdAt)} />
              <Field label="Last sign-in" value={formatDateTime(user.lastSignInAt)} />
            </dl>
          </SectionCard>

          <SectionCard
            title="AI"
            description="How this account's OpenAI usage is handled."
          >
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Key status"
                value={<KeyBadge status={user.keyStatus} />}
              />
              <Field
                label="Fallback policy"
                value={<PolicyBadge policy={user.aiFallbackPolicy} />}
              />
            </dl>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
