import { Button } from "@/components/ui/button";

/**
 * The honest load-failed state (CAR-154, finding F21): a primary loader that
 * fails must render this, not its load-empty copy ("No emails synced yet.",
 * "Your network starts here", etc.), which reads as "you have no data" when the
 * real problem is a failed fetch. Mirrors the outreach shell's ErrorState so the
 * whole app fails the same way. `onRetry` re-invokes the loader.
 *
 * `role="alert"` lives on the message paragraph, not the container, so the
 * assertive live region announces only the text and never wraps the
 * interactive Retry button.
 */
export function LoadErrorState({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center ${className}`}
    >
      <p role="alert" className="text-sm font-medium text-on-surface">{message}</p>
      <p className="max-w-sm text-sm text-muted-foreground">Please try again in a moment.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Compact inline sibling of LoadErrorState for PARTIAL load failures: the
 * primary loader failed but an independently-loaded secondary list (drafts,
 * interactions) is already on screen, so a full-screen error would wipe out
 * good data. Renders as a slim banner above the surviving content instead of
 * replacing it, so the failure is never silently masked (CAR-154 review F4).
 */
export function LoadErrorBanner({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border border-outline-variant bg-surface px-4 py-3 ${className}`}
    >
      <p role="alert" className="text-sm text-on-surface">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
