"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadErrorState } from "@/components/ui/load-error-state";
import { getUserProfile, updateUserProfile } from "@/lib/queries";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { Toggle } from "@/components/ui/toggle";
import { useToast } from "@/components/ui/toast";
import { User, Phone, Mail, Check, Lock, Bell, GraduationCap } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { SchoolAutocomplete } from "@/components/ui/school-autocomplete";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { affinityTransition, resyncBundlesForAffinityGain } from "@/lib/schools/affinity-resync";

export default function AccountSection() {
  const { user } = useAuth();
  const { error: toastError } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  // CAR-213. `universityLoaded` is the value last READ from the profile, kept
  // separately from the edit buffer so an affinity CROSSING can be detected on
  // save. Comparing against the buffer would compare a value to itself.
  const [university, setUniversity] = useState("");
  const [universityIsCustom, setUniversityIsCustom] = useState(false);
  const [universityLoaded, setUniversityLoaded] = useState("");

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
    // `setLoading(true)` as well as clearing the flag, and in that order, so a
    // RETRY re-enters the spinner branch below instead of the form (CAR-205
    // review). Clearing `loadFailed` alone dropped straight back to the form
    // with the name fields still at "" for the whole length of the retry read —
    // the same unloaded-and-writable state the error state exists to prevent,
    // reached through the error state's own Retry button. companies/page.tsx
    // already had this ordering; this file did not.
    setLoading(true);
    setLoadFailed(false);
    try {
      const profile = await getUserProfile(user.id);
      setFirstName(profile.first_name || "");
      setLastName(profile.last_name || "");
      setPhone(profile.phone || "");
      setUniversity(profile.university || "");
      setUniversityIsCustom(profile.university_is_custom ?? false);
      setUniversityLoaded(profile.university || "");
      setNudgesEnabled(profile.followup_nudges_enabled ?? true);
    } catch (err) {
      console.error("Error loading profile:", err);
      // This read is the only source of the name fields, so a failure that fell
      // through left them at "" and the form rendered as though the user had no
      // name on file, with Save live (CAR-205).
      //
      // Precisely what that costs, because the first version of this comment
      // overstated it (CAR-205 review): both name inputs are `required` and the
      // form is not `noValidate`, so a click on Save over blank fields is
      // refused by constraint validation and writes nothing. The reachable loss
      // is the next step — a user who believes the fields are genuinely empty
      // retypes a name to satisfy `required` and saves, which overwrites the
      // stored name with their guess AND writes `phone: null` over a stored
      // phone (the phone input carries no `required` to stop it). The toggle
      // below has the same shape: it renders its `true` default over a
      // preference that may have been off, and flipping it persists the guess.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    // Fire-and-forget: loadProfile logs its own errors and owns `loading`.
    if (user) void loadProfile();
  }, [user, loadProfile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    // Second line of defence, not the fix: the form is not rendered at all while
    // the read has failed or is in flight. It is here because the failure mode
    // this guards is data loss, and a later change that moved the error surface
    // to a banner beside the form would restore it without anything going red.
    // `loading` is included because the retry window is the reachable case.
    if (loadFailed || loading) return;
    setError("");

    // CAR-213: a school edit that CROSSES the affinity boundary silently
    // changes the user's database and the whole look of the app. Gaining
    // affinity drops ~888 contacts in; losing it makes badges vanish, company
    // ordering shift, and next-action lines rewrite themselves. Unannounced,
    // either one reads as a bug rather than as a consequence of what they just
    // did — so say what will happen before it happens. Non-crossing edits (a
    // typo fix, one non-BYU school to another) confirm nothing.
    const transition = affinityTransition(universityLoaded, university);
    if (transition === "gained") {
      const ok = await confirm({
        title: "Add alumni to your network?",
        message:
          "Changing your school adds about 888 contacts to your CRM from the alumni database. They will appear over the next few minutes.",
        confirmLabel: "Save and add them",
      });
      if (!ok) return;
    } else if (transition === "lost") {
      const ok = await confirm({
        title: "Remove alumni highlighting?",
        message:
          "Changing your school removes the alumni highlighting from your contacts. Nothing is deleted: every contact you have stays exactly where it is.",
        confirmLabel: "Save",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      await updateUserProfile(user.id, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim() || null,
        university: university.trim() || null,
        university_is_custom: university.trim() ? universityIsCustom : false,
      });
      const supabase = createSupabaseBrowserClient();
      // Mirror into user_metadata alongside the names (CAR-213). This is the
      // display cache useAlumniAffinity reads so badges and copy resolve
      // synchronously; public.users stays canonical, and nothing server-side
      // trusts the metadata copy.
      await supabase.auth.updateUser({
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          university: university.trim(),
          university_is_custom: university.trim() ? universityIsCustom : false,
        },
      });
      setUniversityLoaded(university.trim());
      // Best-effort: the profile is already saved and the daily sync cron
      // picks these up regardless, so a failure here must not surface as a
      // failed save.
      if (transition === "gained") {
        try {
          await resyncBundlesForAffinityGain(user.id);
        } catch (err) {
          console.error("Failed to queue bundle re-sync after affinity gain:", err);
        }
      }
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
      toastError("Could not save that. Please try again.");
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
      {confirmDialog}
      {/* Profile + notification preference, or the honest failure for both.
          They read the same profile row, so one failed read makes both of them
          lie: the name fields would render blank and the reminders toggle would
          render its `true` default over whatever the user actually chose. The
          password card below is deliberately outside this branch — it goes
          straight to `supabase.auth.updateUser` and reads nothing this loader
          fetched, so a profile failure must not take it away too. */}
      {loadFailed ? (
        <LoadErrorState
          message="Couldn't load your profile."
          onRetry={() => void loadProfile()}
        />
      ) : (
        <>
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

              <div>
                <label className={labelClasses} htmlFor="settings-university">
                  <span className="inline-flex items-center gap-1.5"><GraduationCap className="h-4 w-4" /> School</span>
                </label>
                <SchoolAutocomplete
                  id="settings-university"
                  value={university}
                  onChange={(value, isCustom) => {
                    setUniversity(value);
                    setUniversityIsCustom(isCustom);
                  }}
                  allowCustom
                  placeholder="Where do you go (or did you go) to school? (optional)"
                  className={inputClasses}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  We use this to tailor which contacts and intro emails you get. Leave it blank and we will not highlight any school.
                </p>
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
        </>
      )}

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
