"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import AuthForm from "@/components/auth-form";

/**
 * Stable deep-link for authentication — used by the Chrome extension
 * (sign up / forgot password links) and anything else that needs to send
 * a user straight to a specific auth mode without going through the
 * landing page's state toggle.
 *
 * ?mode=signup → create account, ?mode=reset → forgot password,
 * anything else → sign in. Signed-in users are redirected home.
 */
export default function AuthPageWrapper() {
  return (
    <Suspense>
      <AuthPage />
    </Suspense>
  );
}

function AuthPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();

  const rawMode = searchParams.get("mode");
  const initialMode =
    rawMode === "signup" ? "signup" : rawMode === "reset" ? "forgot" : "signin";

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  if (loading || user) return null;

  return <AuthForm initialMode={initialMode} onBack={() => router.push("/")} />;
}
