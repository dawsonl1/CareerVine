import { Button } from "@/components/ui/button";

/**
 * The honest load-failed state (CAR-154, finding F21): a primary loader that
 * fails must render this, not its load-empty copy ("No emails synced yet.",
 * "Your network starts here", etc.), which reads as "you have no data" when the
 * real problem is a failed fetch. Mirrors the outreach shell's ErrorState so the
 * whole app fails the same way. `onRetry` re-invokes the loader.
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
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center ${className}`}
    >
      <p className="text-sm font-medium text-on-surface">{message}</p>
      <p className="max-w-sm text-sm text-muted-foreground">Please try again in a moment.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
