"use client";

/**
 * Landing target for OAuth connects launched from the onboarding progress
 * modal (CAR-50). The connect buttons open in a new tab so the bundle-apply
 * loop in the original tab survives the Google round-trip; this page just
 * confirms and tries to get out of the way.
 */

import { useEffect } from "react";
import { Check } from "lucide-react";

export default function OnboardingConnectedPage() {
  useEffect(() => {
    // Scripted-open tabs may allow this; if not, the message below stands.
    const t = setTimeout(() => window.close(), 2500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Check className="h-7 w-7 text-primary" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">Connected!</h1>
        <p className="text-sm text-muted-foreground mt-2">
          You can close this tab and head back to CareerVine.
        </p>
      </div>
    </div>
  );
}
