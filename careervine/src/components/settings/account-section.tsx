"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getUserProfile, updateUserProfile } from "@/lib/queries";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { Toggle } from "@/components/ui/toggle";
import { User, Phone, Mail, Check, Lock, Bell } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";

export default function AccountSection() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // CAR-105 email-notification opt-out. Persisted via the browser RLS client; the
  // migration grants UPDATE (followup_nudges_enabled) to authenticated.
  const [nudgesEnabled, setNudgesEnabled] = useState(true);
  const [nudgesSaving, setNudgesSaving] = useState(false);

  // Password
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Cleanup timers on unmount
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    try {
      const profile = await getUserProfile(user.id);
      setFirstName(profile.first_name || "");
      setLastName(profile.last_name || "");
      setPhone(profile.phone || "");
      setNudgesEnabled(profile.followup_nudges_enabled ?? true);
    } catch (err) {
      console.error("Error loading profile:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) loadProfile();
  }, [user, loadProfile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError("");
    setSaving(true);
    try {
      await updateUserProfile(user.id, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim() || null,
      });
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.updateUser({
        data: { first_name: firstName.trim(), last_name: lastName.trim() },
      });
      setSaved(true);
      timersRef.current.push(setTimeout(() => setSaved(false), 2500));
    } catch (err) {
      console.error("Error saving profile:", err);
      setError("Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const toggleNudges = async (value: boolean) => {
    if (!user) return;
    setNudgesEnabled(value); // optimistic
    setNudgesSaving(true);
    try {
      await updateUserProfile(user.id, { followup_nudges_enabled: value });
    } catch (err) {
      console.error("Error saving notification preference:", err);
      setNudgesEnabled(!value); // revert on failure
    } finally {
      setNudgesSaving(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    setPasswordSaving(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
      if (pwErr) throw pwErr;
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
      timersRef.current.push(setTimeout(() => setPasswordSaved(false), 2500));
    } catch (err: unknown) {
      console.error("Error changing password:", err);
      setPasswordError(err instanceof Error ? err.message : "Failed to change password.");
    } finally {
      setPasswordSaving(false);
    }
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-4 text-muted-foreground py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
        <span className="text-base">Loading profile...</span>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {/* Profile */}
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-4 mb-7">
            <div className="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-xl font-medium">
              {(firstName?.[0] || user.email?.[0] || "U").toUpperCase()}
            </div>
            <div>
              <p className="text-lg font-medium text-foreground">
                {firstName || lastName ? `${firstName} ${lastName}`.trim() : "Your profile"}
              </p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>

          <form onSubmit={handleSave} className="space-y-5">
            <div className="grid grid-cols-2 gap-5">
              <div>
                <label className={labelClasses}>
                  <span className="inline-flex items-center gap-1.5"><User className="h-4 w-4" /> First name</span>
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={inputClasses}
                  placeholder="First name"
                  required
                />
              </div>
              <div>
                <label className={labelClasses}>Last name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={inputClasses}
                  placeholder="Last name"
                  required
                />
              </div>
            </div>

            <div>
              <label className={labelClasses}>
                <span className="inline-flex items-center gap-1.5"><Mail className="h-4 w-4" /> Email</span>
              </label>
              <input
                type="email"
                value={user.email || ""}
                disabled
                className={`${inputClasses} opacity-50 cursor-not-allowed`}
              />
              <p className="text-xs text-muted-foreground mt-1">Email is managed through authentication and cannot be changed here.</p>
            </div>

            <div>
              <label className={labelClasses}>
                <span className="inline-flex items-center gap-1.5"><Phone className="h-4 w-4" /> Phone</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={inputClasses}
                placeholder="555-123-4567 (optional)"
              />
            </div>

            {error && <p className="text-base text-destructive">{error}</p>}

            <div className="flex items-center gap-4 pt-3">
              <Button type="submit" loading={saving}>Save changes</Button>
              {saved && (
                <span className="inline-flex items-center gap-1.5 text-base text-primary font-medium animate-pulse">
                  <Check className="h-5 w-5" /> Saved
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Email notifications */}
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-6">
            <Bell className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Email notifications</h2>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-medium text-foreground">Follow-up reminders</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Get an email when a follow-up is waiting for your review, with a reminder or two before it expires.
              </p>
            </div>
            <Toggle
              checked={nudgesEnabled}
              disabled={nudgesSaving}
              onChange={(v) => void toggleNudges(v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Change password */}
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-6">
            <Lock className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Change password</h2>
          </div>

          <form onSubmit={handlePasswordChange} className="space-y-5">
            <div>
              <label className={labelClasses}>New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClasses}
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
            </div>
            <div>
              <label className={labelClasses}>Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClasses}
                placeholder="Re-enter new password"
                required
              />
            </div>

            {passwordError && <p className="text-base text-destructive">{passwordError}</p>}

            <div className="flex items-center gap-4 pt-3">
              <Button type="submit" loading={passwordSaving}>Update password</Button>
              {passwordSaved && (
                <span className="inline-flex items-center gap-1.5 text-base text-primary font-medium animate-pulse">
                  <Check className="h-5 w-5" /> Password updated
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
