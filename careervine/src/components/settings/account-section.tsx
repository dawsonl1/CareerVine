"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getUserProfile, updateUserProfile } from "@/lib/queries";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { User, Phone, Mail, Check, Lock } from "lucide-react";
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

  // Password
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  const loadProfile = useCallback(async () => {
    if (!user) return;
    try {
      const profile = await getUserProfile(user.id);
      setFirstName(profile.first_name || "");
      setLastName(profile.last_name || "");
      setPhone(profile.phone || "");
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
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      console.error("Error saving profile:", err);
      setError("Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
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
      setTimeout(() => setPasswordSaved(false), 2500);
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
      <div className="flex items-center gap-3 text-muted-foreground py-8">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading profile...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Profile */}
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-lg font-medium">
              {(firstName?.[0] || user.email?.[0] || "U").toUpperCase()}
            </div>
            <div>
              <p className="text-base font-medium text-foreground">
                {firstName || lastName ? `${firstName} ${lastName}`.trim() : "Your profile"}
              </p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClasses}>
                  <span className="inline-flex items-center gap-1"><User className="h-3 w-3" /> First name</span>
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
                <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> Email</span>
              </label>
              <input
                type="email"
                value={user.email || ""}
                disabled
                className={`${inputClasses} opacity-50 cursor-not-allowed`}
              />
              <p className="text-[11px] text-muted-foreground mt-1">Email is managed through authentication and cannot be changed here.</p>
            </div>

            <div>
              <label className={labelClasses}>
                <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> Phone</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={inputClasses}
                placeholder="555-123-4567 (optional)"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" loading={saving}>Save changes</Button>
              {saved && (
                <span className="inline-flex items-center gap-1 text-sm text-primary font-medium animate-pulse">
                  <Check className="h-4 w-4" /> Saved
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Change password */}
      <Card variant="outlined">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <Lock className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">Change password</h2>
          </div>

          <form onSubmit={handlePasswordChange} className="space-y-4">
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

            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" loading={passwordSaving}>Update password</Button>
              {passwordSaved && (
                <span className="inline-flex items-center gap-1 text-sm text-primary font-medium animate-pulse">
                  <Check className="h-4 w-4" /> Password updated
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
