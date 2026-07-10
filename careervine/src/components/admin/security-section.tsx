"use client";

/**
 * Admin user-detail: security card — password management (reset link / set
 * directly) and the make/revoke-admin control.
 *
 * Destructive-action policy: everything here changes credentials or
 * privileges, so every action goes through an explicit confirm modal echoing
 * the target's email; nothing is optimistic.
 */

import { useState } from "react";
import { Copy, Check, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/components/auth-provider";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import type { AdminUserDetail } from "@/lib/admin-users";

type OpenModal = null | "link" | "set" | "role";

export default function SecuritySection({
  user,
  onChanged,
}: {
  user: AdminUserDetail;
  onChanged: () => void;
}) {
  const { user: me } = useAuth();
  const { success, error: toastError } = useToast();

  const [open, setOpen] = useState<OpenModal>(null);
  const [busy, setBusy] = useState(false);
  const [actionLink, setActionLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const isSelf = me?.id === user.id;
  const email = user.email ?? "(no email)";

  const close = () => {
    setOpen(null);
    setActionLink(null);
    setCopied(false);
    setNewPassword("");
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  };

  const generateLink = async () => {
    setBusy(true);
    try {
      const json = await post(`/api/admin/users/${user.id}/password`, { mode: "link" });
      if (!json.actionLink) throw new Error("No link returned");
      setActionLink(json.actionLink);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!actionLink) return;
    await navigator.clipboard.writeText(actionLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const setPassword = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/users/${user.id}/password`, {
        mode: "set",
        password: newPassword,
      });
      success(`Password set for ${email} — their sessions were signed out`);
      close();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/users/${user.id}/role`, {
        role: user.isAdmin ? null : "admin",
      });
      success(
        user.isAdmin
          ? `Revoked admin from ${email}`
          : `${email} is now an admin — takes effect on their next sign-in`,
      );
      close();
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">Security</h2>

      <div className="mt-4 flex flex-col gap-3">
        {/* Password */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-on-surface">Password</p>
            <p className="text-sm text-muted-foreground">
              Generate a reset link to send them, or set a password directly.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="tonal" size="sm" onClick={() => setOpen("link")}>
              <KeyRound className="mr-1.5 h-4 w-4" />
              Reset link
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOpen("set")}>
              Set password
            </Button>
          </div>
        </div>

        <hr className="border-outline-variant" />

        {/* Role */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-on-surface">Admin access</p>
            <p className="text-sm text-muted-foreground">
              {user.isAdmin
                ? "This account can manage all users, access, and settings."
                : "Grant full access to this dashboard and every account."}
            </p>
          </div>
          {isSelf ? (
            <Tooltip label="You can't revoke your own admin access">
              <span>
                <Button variant="outline" size="sm" disabled>
                  <ShieldOff className="mr-1.5 h-4 w-4" />
                  Revoke admin
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              variant={user.isAdmin ? "danger" : "tonal"}
              size="sm"
              onClick={() => setOpen("role")}
            >
              {user.isAdmin ? (
                <>
                  <ShieldOff className="mr-1.5 h-4 w-4" />
                  Revoke admin
                </>
              ) : (
                <>
                  <ShieldCheck className="mr-1.5 h-4 w-4" />
                  Make admin
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Reset-link modal */}
      <Modal isOpen={open === "link"} onClose={close} title="Password reset link" size="md">
        {!actionLink ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generate a single-use password reset link for{" "}
              <span className="font-medium text-on-surface">{email}</span>. The
              link is shown once, only to you — you deliver it to them yourself.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="text" onClick={close}>
                Cancel
              </Button>
              <Button onClick={generateLink} loading={busy}>
                Generate link
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Copy this link now — it won&apos;t be shown again, expires, and can
              only be used once.
            </p>
            <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container p-3">
              <code className="min-w-0 flex-1 truncate text-xs text-on-surface">
                {actionLink}
              </code>
              <Button variant="tonal" size="sm" onClick={copyLink}>
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Set-password modal */}
      <Modal isOpen={open === "set"} onClose={close} title="Set password" size="md">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Set a new password for{" "}
            <span className="font-medium text-on-surface">{email}</span>. All of
            their active sessions will be signed out.
          </p>
          <div>
            <label className={labelClasses}>New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputClasses}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={setPassword}
              loading={busy}
              disabled={newPassword.length < 8}
            >
              Set password
            </Button>
          </div>
        </div>
      </Modal>

      {/* Role confirm modal */}
      <Modal
        isOpen={open === "role"}
        onClose={close}
        title={user.isAdmin ? "Revoke admin access" : "Make admin"}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {user.isAdmin ? (
              <>
                Revoke admin access from{" "}
                <span className="font-medium text-on-surface">{email}</span>?
                They&apos;ll lose access to this dashboard on their next sign-in.
              </>
            ) : (
              <>
                Give <span className="font-medium text-on-surface">{email}</span>{" "}
                full admin access? They&apos;ll be able to manage every account,
                including yours. Takes effect on their next sign-in.
              </>
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={user.isAdmin ? "danger" : "primary"}
              onClick={changeRole}
              loading={busy}
            >
              {user.isAdmin ? "Revoke admin" : "Make admin"}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
