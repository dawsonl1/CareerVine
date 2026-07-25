"use client";

/**
 * Root segment error boundary (CAR-184).
 *
 * Catches render throws from every page, nested layout, and their descendants.
 * It does NOT catch throws from `app/layout.tsx` itself, because Next places this
 * boundary inside that layout. The root layout mounts eight client providers
 * (AuthProvider, AnalyticsProvider, ToastProvider, ComposeEmailProvider,
 * OnboardingProvider, ExtensionOnboardingProvider, QuickCaptureProvider,
 * SignedOutRedirect), and a throw in any of those bubbles straight past this file.
 * `app/global-error.tsx` is what covers that gap, so the two are complementary
 * rather than redundant.
 *
 * Because this renders inside those providers, the design system and
 * `<Navigation />` are safe to use here. Navigation is deliberately included: it
 * lives per-page in this app rather than in the root layout, so without it the
 * error panel would be a dead end with no way out. If Navigation itself were the
 * thing that threw, the throw escalates to global-error, which is the correct
 * layering.
 *
 * `unstable_retry()` is used over `reset()` on Next's own recommendation: reset
 * only clears the error state without re-fetching, so it cannot recover a Server
 * Component error, while retry re-fetches and re-renders inside a transition.
 */

import { useEffect, useRef } from "react";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { reportBoundaryError } from "@/lib/report-error";

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reportBoundaryError("root", error, { digest: error.digest });
  }, [error]);

  // The throw destroyed the page the user was on, so focus fell to <body>. Move it
  // to the panel to put the recovery controls one Tab away.
  useEffect(() => {
    panelRef.current?.focus();
  }, [error]);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-8">
        <div
          ref={panelRef}
          tabIndex={-1}
          className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-20 text-center outline-none"
        >
          {/* role="alert" on the message only, so the live region announces the
              text without wrapping the buttons (matches LoadErrorState). */}
          <p role="alert" className="text-base font-medium text-on-surface">
            Something went wrong.
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            This page ran into an unexpected problem. Trying again will often fix it.
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => unstable_retry()}>
              Try again
            </Button>
            <Button variant="text" size="sm" href="/">
              Go to Home
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
