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
 * hand-rolled boundary gets wrong:
 *
 *  1. It RE-THROWS Next's router errors. `redirect()`, `notFound()`, `forbidden()`
 *     and `unauthorized()` all work by throwing sentinel errors. A hand-rolled
 *     boundary catches them and renders "something went wrong" where the user
 *     should have been redirected. `app/admin/layout.tsx` redirects non-admins and
 *     `contacts/[id]` is a dynamic route, so this is a live hazard here, not theory.
 *  2. It clears its own error state when the PATHNAME changes, so a user who trips
 *     an error on one contact does not carry the error panel to the next contact.
 *     A hand-rolled boundary stays stuck until remounted.
 *  3. `unstable_retry()` refreshes the router inside a `startTransition`, preserving
 *     client state outside the boundary. Plain `reset()` only clears the error state.
 *
 * All three are asserted in `src/__tests__/error-boundaries.test.tsx`: 1 and 2
 * directly, and 3 by providing an `AppRouterContext` and checking `refresh()` is
 * actually called (without that provider `unstable_retry` silently degrades to
 * `reset`, so a test without it cannot tell the two apart).
 *
 * Two costs are worth naming, since neither is free:
 *
 *  - The `unstable_` prefix. Confined to this one module on purpose, so a rename in
 *    a future Next is a one-line change, and the test above asserts the export still
 *    exists rather than letting it break in production.
 *  - `next/error`'s first statement is `module.exports = require('./dist/pages/_error')`,
 *    which is CJS and unshakeable, so importing it also pulls the Pages Router error
 *    page and `next/head` into every client chunk that uses this component: measured
 *    at ~15 KB raw / ~1.8 KB gzip across three chunks in this app. Deep-importing
 *    `next/dist/client/components/catch-error` avoids it but trades the public entry
 *    point for a private path, which is the worse deal while the API is unstable.
 *
 * ## RECOVERY CONTRACT — read this before adopting the component
 *
 * The retry re-renders the children. It does NOT re-fetch data that a PARENT owns,
 * and `unstable_retry`'s `router.refresh()` does not re-run a client component's
 * `useEffect` loaders or replace parent-held `useState`. Every wrapped subtree in
 * this app is a presentational leaf whose data lives in the page above it. So a
 * boundary that is merely wrapped, with nothing else done, produces two bugs:
 *
 *  - "Try again" is a no-op. The children re-render against the same bad data and
 *    throw again, pixel-identically, so the button looks broken.
 *  - Worse, a SUCCESSFUL refresh from elsewhere on the page (a Sync button, a UI
 *    event) does not clear the panel. The data is fixed and the section still says
 *    it failed, with no way out but navigating away.
 *
 * The boundary must therefore be remounted or unmounted whenever the data behind it
 * changes. Each adoption site satisfies that in one of two ways:
 *
 *  1. **The site already gates the subtree behind a loading flag** that its retry
 *     re-asserts. Setting the flag unmounts this boundary, which discards the error
 *     for free. Wire `onReset` to that existing retry and you are done. The inbox
 *     (`setLoading(true); void loadInbox()`) and the calendar (`loadData()`, which
 *     sets its own loading flag and early-returns a spinner) both work this way.
 *  2. **The site keeps the subtree mounted during a refresh.** Then include a data
 *     generation counter in the `key`, bumped whenever the load completes, so fresh
 *     data remounts the boundary. `contacts/[id]` works this way, because its
 *     `loadingData` is passed to children as a prop rather than gating them.
 *
 * An `onReset` that only kicks off an ASYNC refetch is NOT sufficient on its own:
 * `reset()` clears the error synchronously, the child re-throws on the still-stale
 * data before the fetch resolves, and the late state update lands behind a re-set
 * error flag. It must either unmount the boundary (case 1) or be paired with a
 * generation key (case 2).
 *
 * ## Pass a `key` when sections switch WITHOUT navigating
 *
 * Point 2 above keys off the pathname. Tab strips and anything else that swaps
 * sections via same-route state do not change the pathname, so the boundary would
 * keep showing the error panel after the user switches away from the broken section:
 *
 *     <SectionBoundary key={activeTab} label="inbox-tabs">…</SectionBoundary>
 *
 * The key is load-bearing wherever one boundary element spans several sibling
 * section conditionals, which is the case on the inbox and on contact detail. It is
 * NOT needed when an enclosing conditional already unmounts the boundary on the
 * switch (the calendar's `{view === "week" && …}` does exactly that).
 *
 * ## Scope
 *
 * This catches errors thrown during RENDER. It does not catch rejected promises in
 * event handlers or effects; those are the client mutation contract's job
 * (`withToastOnError` / `apiFetch`, CONVENTIONS.md section f).
 */

import { useEffect, useRef, type ReactNode } from "react";
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
   * way; a custom node owns its own retry affordance and focus handling.
   */
  fallback?: ReactNode;
  /**
   * Runs before the retry. Wire this to the site's existing retry closure. See the
   * RECOVERY CONTRACT above: without it, "Try again" cannot recover, and an async
   * refetch alone is not enough.
   */
  onReset?: () => void;
  /**
   * Applies to the ERROR PANEL only. In the happy path this component renders no
   * wrapper element at all (the boundary returns `children` verbatim), so there is
   * nothing for these classes to land on until the boundary trips.
   */
  className?: string;
};

function SectionBoundaryFallback(
  { label, message, fallback, onReset, className = "" }: SectionBoundaryProps,
  { error, unstable_retry }: NextErrorInfo
) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Report once per caught error, not on every re-render of the panel.
  useEffect(() => {
    reportBoundaryError("section", error, { label });
  }, [error, label]);

  // A trip destroys whatever the user was focused on inside this subtree, which
  // drops focus to <body> and leaves a keyboard user tabbing from the top of the
  // page to reach "Try again". Move focus to the panel so the recovery control is
  // one Tab away. This is why the boundary differs from LoadErrorState, which
  // never destroys the focused element.
  useEffect(() => {
    panelRef.current?.focus();
  }, [error]);

  if (fallback !== undefined) return <>{fallback}</>;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center outline-none ${className}`}
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
