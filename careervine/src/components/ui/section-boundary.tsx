"use client";

/**
 * SectionBoundary — contain a render throw to one section of a page (CAR-184).
 *
 * Wrap any subtree that can independently fail. When a descendant throws during
 * render, this shows a retryable panel in that subtree's own frame and the rest of
 * the page keeps working, instead of the throw unmounting the whole React tree.
 *
 * ## Why this is built on `unstable_catchError` and not a hand-rolled class
 *
 * CAR-184 originally specified a class component with `getDerivedStateFromError`.
 * Next 16.2 added `unstable_catchError` (`next/error`), which does three things a
 * hand-rolled boundary gets wrong. All three were verified empirically against this
 * repo's jsdom setup before choosing it, and 1 and 3 are pinned by tests in
 * `src/__tests__/error-boundaries.test.tsx`:
 *
 *  1. It RE-THROWS Next's router errors. `redirect()`, `notFound()`, `forbidden()`
 *     and `unauthorized()` all work by throwing sentinel errors. A hand-rolled
 *     boundary catches them and renders "something went wrong" where the user
 *     should have been redirected. `app/admin/layout.tsx` redirects non-admins and
 *     `contacts/[id]` is a dynamic route, so this is a live hazard here, not theory.
 *  2. It clears its own error state when the PATHNAME changes, so a user who trips
 *     an error on one contact does not carry the error panel to the next contact.
 *     A hand-rolled boundary stays stuck until remounted.
 *  3. `unstable_retry()` re-fetches and re-renders inside a `startTransition`,
 *     preserving client state outside the boundary. Plain `reset()` only clears the
 *     error state without re-fetching, so it cannot recover a Server Component
 *     error at all.
 *
 * The `unstable_` prefix is the cost. It is confined to this one module on purpose:
 * a rename in a future Next is a one-line change here, and
 * `error-boundaries.test.tsx` asserts the export still exists so a Next bump that
 * drops it fails a test instead of breaking production.
 *
 * ## Pass a `key` when sections switch WITHOUT navigating
 *
 * Point 2 keys off the pathname. Tab strips, view toggles and anything else that
 * swaps sections via same-route state do not change the pathname, so the boundary
 * would keep showing the error panel after the user switches away from the broken
 * section. Give it a key so the section change remounts it:
 *
 *     <SectionBoundary key={activeTab} label="inbox-tabs">…</SectionBoundary>
 *
 * All three adoption sites do this (inbox tabs, calendar view toggle, contact tabs).
 *
 * ## Scope
 *
 * This catches errors thrown during RENDER. It does not catch rejected promises in
 * event handlers or effects; those are the client mutation contract's job
 * (`withToastOnError` / `apiFetch`, CONVENTIONS.md section f).
 */

import { useEffect, type ReactNode } from "react";
import { unstable_catchError, type ErrorInfo as NextErrorInfo } from "next/error";
import { Button } from "@/components/ui/button";
import { reportBoundaryError } from "@/lib/report-error";

type SectionBoundaryProps = {
  /**
   * Short identifier for the logs, e.g. "inbox-tabs". Not user-visible: it is
   * only forwarded to the reporter so a boundary hit is traceable to a surface.
   */
  label?: string;
  /** Override the default panel copy. Keep it plain and free of em dashes (rule 35). */
  message?: string;
  /**
   * Replace the whole panel. Prefer the default so the app fails one recognizable
   * way; a custom node owns its own retry affordance.
   */
  fallback?: ReactNode;
  /**
   * Runs before the retry. Use it to clear the local state that caused the throw
   * (a bad selection, a stale filter), otherwise the retry re-renders straight
   * back into the same error.
   */
  onReset?: () => void;
  className?: string;
};

function SectionBoundaryFallback(
  { label, message, fallback, onReset, className = "" }: SectionBoundaryProps,
  { error, unstable_retry }: NextErrorInfo
) {
  // Report once per caught error, not on every re-render of the panel.
  useEffect(() => {
    reportBoundaryError("section", error, { label });
  }, [error, label]);

  if (fallback !== undefined) return <>{fallback}</>;

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center ${className}`}
    >
      {/* role="alert" on the message only, so the assertive live region announces
          the text and never wraps the interactive button (matches LoadErrorState). */}
      <p role="alert" className="text-sm font-medium text-on-surface">
        {message ?? "Something went wrong loading this section."}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        The rest of the page is still working.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          onReset?.();
          unstable_retry();
        }}
      >
        Try again
      </Button>
    </div>
  );
}

export const SectionBoundary = unstable_catchError(SectionBoundaryFallback);
