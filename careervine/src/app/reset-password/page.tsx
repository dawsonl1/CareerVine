"use client";

import { useState, useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { Button } from "@/components/ui/button";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { Lock, Check, AlertCircle } from "lucide-react";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    // Supabase automatically handles the token from the URL hash
    // and establishes a session via onAuthStateChange
    const supabase = createSupabaseBrowserClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setSessionReady(true);
      }
    });

    // Also check if session is already established
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSessionReady(true);
      } else {
        // Give a moment for the token exchange to complete
        setTimeout(() => {
          supabase.auth.getSession().then(({ data: { session: s } }) => {
            if (s) {
              setSessionReady(true);
            } else {
              setSessionError(true);
            }
          });
        }, 2000);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update password. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center mx-auto mb-4">
            <Lock className="h-7 w-7 text-on-primary-container" />
          </div>
          <h1 className="text-2xl font-medium text-foreground">Reset your password</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter a new password for your account.</p>
        </div>

        {success ? (
          <div className="text-center p-6 rounded-2xl bg-surface-container-high">
            <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-3">
              <Check className="h-6 w-6 text-primary" />
            </div>
            <p className="text-base font-medium text-foreground mb-1">Password updated</p>
            <p className="text-sm text-muted-foreground mb-4">Your password has been successfully changed.</p>
            <a href="/">
              <Button type="button">Go to Dashboard</Button>
            </a>
          </div>
        ) : sessionError ? (
          <div className="text-center p-6 rounded-2xl bg-surface-container-high">
            <div className="w-12 h-12 rounded-full bg-destructive/15 flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <p className="text-base font-medium text-foreground mb-1">Invalid or expired link</p>
            <p className="text-sm text-muted-foreground mb-4">
              This password reset link is invalid or has expired. Please request a new one.
            </p>
            <a href="/">
              <Button type="button">Back to login</Button>
            </a>
          </div>
        ) : !sessionReady ? (
          <div className="flex items-center justify-center gap-3 text-muted-foreground py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Verifying reset link...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 rounded-2xl bg-surface-container-high space-y-4">
            <div>
              <label className={labelClasses}>New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClasses}
                placeholder="At least 6 characters"
                required
                minLength={6}
                autoFocus
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

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" loading={saving} className="w-full">
              Update password
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
