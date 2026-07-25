"use client";

/**
 * Error boundary for the /admin surface (CAR-184).
 *
 * `app/admin/` has its own layout, so it needs its own boundary: without this file
 * an admin page throw would bubble to `app/error.tsx`, which replaces the admin
 * chrome entirely.
 *
 * Next places this boundary INSIDE `app/admin/layout.tsx`, so the layout's
 * `<Navigation />` and `<main>` wrapper are already on screen. This file must not
 * render either again. The same nesting rule means the layout's own
 * `redirect("/")` for non-admins is above this boundary and unaffected by it, so a
 * non-admin is still redirected rather than shown an error panel.
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { reportBoundaryError } from "@/lib/report-error";

export default function AdminError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reportBoundaryError("admin", error, { digest: error.digest });
  }, [error]);

  // Focus the panel: the throw destroyed the view the user was on, so focus fell to
  // <body> and the recovery controls would otherwise be a full tab traversal away.
  useEffect(() => {
    panelRef.current?.focus();
  }, [error]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-20 text-center outline-none"
    >
      <p role="alert" className="text-base font-medium text-on-surface">
        Something went wrong.
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        This admin view ran into an unexpected problem. Trying again will often fix it.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" onClick={() => unstable_retry()}>
          Try again
        </Button>
        <Button variant="text" size="sm" href="/admin">
          Back to Admin
        </Button>
      </div>
    </div>
  );
}
