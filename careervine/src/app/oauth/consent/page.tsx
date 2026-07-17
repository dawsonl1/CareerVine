"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type AuthDetails = {
  authorization_id: string;
  redirect_url?: string;
  client: { name: string };
  user: { email: string };
  scope: string;
};

export default function OAuthConsentPage() {
  return (
    <Suspense>
      <OAuthConsentContent />
    </Suspense>
  );
}

function OAuthConsentContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading: authLoading, signIn } = useAuth();
  const authorizationId = searchParams.get("authorization_id");

  const [details, setDetails] = useState<AuthDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);

  // Load the authorization details once the user is known. State is only set
  // after the await, so this is an async data load, not a synchronous
  // set-state-in-effect.
  useEffect(() => {
    if (authLoading || !user || !authorizationId) return;
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data, error: detailsError } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (cancelled) return;
      if (detailsError) {
        setError(detailsError.message);
        return;
      }
      if (data?.redirect_url) {
        window.location.href = data.redirect_url;
        return;
      }
      if (data) {
        setError(null);
        setDetails(data as AuthDetails);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, authorizationId]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignInError(null);
    const result = await signIn(email, password);
    if (result.error) setSignInError(result.error);
  };

  const decide = async (approved: boolean) => {
    if (!authorizationId) return;
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { data, error: consentError } = approved
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    setBusy(false);
    if (consentError) {
      setError(consentError.message);
      return;
    }
    if (data?.redirect_url) {
      window.location.href = data.redirect_url;
      return;
    }
    router.push("/settings?tab=integrations");
  };

  if (!authorizationId) {
    return <ConsentShell error="Invalid authorization link." />;
  }

  if (authLoading) {
    return <ConsentShell loading />;
  }

  if (!user) {
    return (
      <ConsentShell
        title="Sign in to continue"
        subtitle="Claude needs your approval to connect to CareerVine."
      >
        <form onSubmit={handleSignIn} className="space-y-4">
          <label className="block text-sm text-muted-foreground">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-outline bg-surface px-3 py-2 text-foreground"
            />
          </label>
          <label className="block text-sm text-muted-foreground">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-outline bg-surface px-3 py-2 text-foreground"
            />
          </label>
          {signInError && <p className="text-sm text-destructive">{signInError}</p>}
          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </form>
      </ConsentShell>
    );
  }

  // A missing authorization_id is derived from the (stable) URL param rather
  // than pushed into state from an effect.
  const displayError = error ?? (authorizationId ? null : "Missing authorization_id.");
  if (displayError) {
    return <ConsentShell error={displayError} />;
  }

  if (!details) {
    return <ConsentShell loading subtitle="Loading authorization request…" />;
  }

  const clientName = details.client?.name ?? "An application";

  return (
    <ConsentShell
      title="Connect Claude to CareerVine"
      subtitle={`${clientName} wants to access your CareerVine account.`}
    >
      <div className="space-y-4 text-sm text-muted-foreground">
        <p>
          Signed in as <span className="text-foreground font-medium">{details.user.email}</span>
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Read and manage your contacts, outreach queue, and company intel</li>
          <li>Create Gmail drafts and send email (100/day cap; drafts are the default)</li>
          <li>Log interactions, action items, and calendar events</li>
        </ul>
        <p>You can disconnect anytime from Claude&apos;s connector settings.</p>
      </div>
      <div className="mt-6 flex gap-3">
        <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </Button>
        <Button className="flex-1" loading={busy} onClick={() => void decide(true)}>
          Approve
        </Button>
      </div>
    </ConsentShell>
  );
}

function ConsentShell({
  title = "CareerVine",
  subtitle,
  error,
  loading,
  children,
}: {
  title?: string;
  subtitle?: string;
  error?: string;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          <h1 className="text-2xl font-normal text-foreground">{title}</h1>
          {subtitle && <p className="mt-2 text-base text-muted-foreground">{subtitle}</p>}
          {loading && <p className="mt-6 text-sm text-muted-foreground">Please wait…</p>}
          {error && <p className="mt-6 text-sm text-destructive">{error}</p>}
          {children && <div className="mt-6">{children}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
