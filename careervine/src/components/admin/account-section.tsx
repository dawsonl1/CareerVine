"use client";

/**
 * Admin user-detail: account card — status/metadata plus the suspend/
 * reactivate and delete controls.
 *
 * Both actions are irreversible-ish and cross-account, so both use explicit
 * confirm modals (delete = type-to-confirm), never optimistic writes.
 */

import { useState } from "react";
import { Ban, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/components/auth-provider";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import type { AdminUserDetail } from "@/lib/admin-users";

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

type OpenModal = null | "suspend" | "delete";

export default function AccountSection({
  user,
  onChanged,
  onDeleted,
}: {
  user: AdminUserDetail;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { user: me } = useAuth();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState<OpenModal>(null);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const isSelf = me?.id === user.id;
  const suspended = user.status === "suspended";
  const email = user.email ?? "(no email)";

  const close = () => {
    setOpen(null);
    setConfirmText("");
  };

  const setStatus = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: suspended ? "active" : "suspended" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(
        suspended
          ? `Reactivated ${email}`
          : `Suspended ${email}: sessions revoked, queued work held`,
      );
      close();
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(`Deleted ${email}`);
      close();
      onDeleted();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">Account</h2>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Status" value={suspended ? "Suspended" : "Active"} />
        <Field label="Role" value={user.isAdmin ? "Admin" : "Member"} />
        <Field label="Created" value={formatDateTime(user.createdAt)} />
        <Field label="Last sign-in" value={formatDateTime(user.lastSignInAt)} />
      </dl>

      <hr className="my-4 border-outline-variant" />

      <div className="flex flex-col gap-3">
        {/* Suspend / reactivate */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-on-surface">
              {suspended ? "Reactivate account" : "Suspend account"}
            </p>
            <p className="text-sm text-muted-foreground">
              {suspended
                ? "Restore sign-in and resume their held emails and syncs."
                : "Blocks sign-in, signs them out everywhere, and holds queued work."}
            </p>
          </div>
          {isSelf ? (
            <Tooltip label="You can't suspend your own account">
              <span>
                <Button variant="outline" size="sm" disabled>
                  <Ban className="mr-1.5 h-4 w-4" />
                  Suspend
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              variant={suspended ? "tonal" : "danger"}
              size="sm"
              onClick={() => setOpen("suspend")}
            >
              {suspended ? (
                <>
                  <RotateCcw className="mr-1.5 h-4 w-4" />
                  Reactivate
                </>
              ) : (
                <>
                  <Ban className="mr-1.5 h-4 w-4" />
                  Suspend
                </>
              )}
            </Button>
          )}
        </div>

        {/* Delete */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-on-surface">Delete account</p>
            <p className="text-sm text-muted-foreground">
              Permanently removes the account and all of its data.
            </p>
          </div>
          {isSelf || user.isAdmin ? (
            <Tooltip
              label={
                isSelf
                  ? "You can't delete your own account"
                  : "Revoke admin access before deleting this account"
              }
            >
              <span>
                <Button variant="outline" size="sm" disabled>
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  Delete
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setOpen("delete")}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Suspend / reactivate confirm */}
      <Modal
        isOpen={open === "suspend"}
        onClose={close}
        title={suspended ? "Reactivate account" : "Suspend account"}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {suspended ? (
              <>
                Reactivate <span className="font-medium text-on-surface">{email}</span>?
                They&apos;ll be able to sign in again, and their held emails and
                syncs will resume.
              </>
            ) : (
              <>
                Suspend <span className="font-medium text-on-surface">{email}</span>?
                They&apos;ll be signed out everywhere and blocked from signing in.
                Scheduled emails and syncs are held until reactivation.
              </>
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={suspended ? "primary" : "danger"}
              onClick={setStatus}
              loading={busy}
            >
              {suspended ? "Reactivate" : "Suspend"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete type-to-confirm */}
      <Modal isOpen={open === "delete"} onClose={close} title="Delete account" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This permanently deletes{" "}
            <span className="font-medium text-on-surface">{email}</span>: their
            contacts, meetings, emails, and settings. This cannot be undone.
          </p>
          <div>
            <label className={labelClasses}>
              Type <span className="font-mono">{email}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className={inputClasses}
              placeholder={email}
              autoComplete="off"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={deleteAccount}
              loading={busy}
              disabled={confirmText !== email}
            >
              Delete forever
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
