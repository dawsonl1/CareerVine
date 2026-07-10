"use client";

/**
 * Admin user-detail: editable profile card (first/last/email/phone).
 * Confirmed (non-optimistic) writes — cross-account edits can fail server-side
 * and must never show success speculatively.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import type { AdminUserDetail } from "@/lib/admin-users";

export default function ProfileSection({
  user,
  onChanged,
}: {
  user: AdminUserDetail;
  onChanged: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [email, setEmail] = useState(user.email ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    firstName !== user.firstName ||
    lastName !== user.lastName ||
    email !== (user.email ?? "") ||
    phone !== (user.phone ?? "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          email: email || undefined,
          phone: phone || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
      success("Profile updated");
      onChanged();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">Profile</h2>
      <form onSubmit={handleSave} className="mt-4 space-y-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClasses}>First name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputClasses}
            />
          </div>
          <div>
            <label className={labelClasses}>Last name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={inputClasses}
            />
          </div>
          <div>
            <label className={labelClasses}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClasses}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Changing this updates the login email immediately — no confirmation
              email is sent.
            </p>
          </div>
          <div>
            <label className={labelClasses}>Phone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClasses}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || saving} loading={saving}>
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}
