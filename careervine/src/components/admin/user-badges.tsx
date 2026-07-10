/**
 * Small, consistent status chips for the admin user surface — reused by the
 * list rows and the detail header so a user reads the same way everywhere.
 */

import type { AdminUserKeyStatus } from "@/lib/admin-users";

function Chip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

export function AdminBadge() {
  return <Chip label="Admin" className="bg-tertiary-container text-on-tertiary-container" />;
}

export function StatusBadge({ status }: { status: "active" | "suspended" }) {
  if (status === "active") return null;
  return <Chip label="Suspended" className="bg-error-container text-on-error-container" />;
}

const KEY_LABELS: Record<AdminUserKeyStatus, { label: string; className: string }> = {
  active: { label: "Own key", className: "bg-primary-container text-on-primary-container" },
  invalid: { label: "Key invalid", className: "bg-error-container text-on-error-container" },
  quota_exceeded: {
    label: "Quota exceeded",
    className: "bg-surface-container-high text-on-surface-variant",
  },
  none: { label: "No key", className: "bg-surface-container-high text-on-surface-variant" },
};

export function KeyBadge({ status }: { status: AdminUserKeyStatus }) {
  const { label, className } = KEY_LABELS[status];
  return <Chip label={label} className={className} />;
}

export function PolicyBadge({ policy }: { policy: "cutoff" | "shared" }) {
  return policy === "cutoff" ? (
    <Chip label="AI cutoff" className="bg-surface-container-high text-on-surface-variant" />
  ) : (
    <Chip label="Shared fallback" className="bg-surface-container-high text-on-surface-variant" />
  );
}
