"use client";

/**
 * CAR-26 — the single graceful-failure surface for AI features.
 *
 * Presentational only: given an AiFailureCode, it renders the matching copy from
 * AI_FAILURE_COPY with a CTA to the Settings → AI tab (and a Retry when the
 * failure is retryable). Every AI feature drops this into its existing error
 * region instead of showing a raw string, so the three token states read
 * identically everywhere.
 */

import { Sparkles, AlertTriangle, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_FAILURE_COPY, type AiFailureCode } from "@/lib/ai-errors";

const ICONS: Record<AiFailureCode, typeof Sparkles> = {
  ai_no_key: Sparkles,
  ai_key_invalid: AlertTriangle,
  ai_quota_exhausted: AlertTriangle,
  ai_unavailable: CloudOff,
};

interface AiUnavailableNoticeProps {
  code: AiFailureCode;
  /** Shown as a "Try again" button when the failure is retryable. */
  onRetry?: () => void;
  /** Tightens padding for dense contexts like a dropdown. */
  compact?: boolean;
  className?: string;
}

export function AiUnavailableNotice({
  code,
  onRetry,
  compact = false,
  className = "",
}: AiUnavailableNoticeProps) {
  const copy = AI_FAILURE_COPY[code];
  const Icon = ICONS[code];
  const showRetry = copy.retryable && Boolean(onRetry);

  return (
    <div
      role="status"
      className={`flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-foreground ${
        compact ? "px-3 py-2.5" : "px-4 py-3"
      } ${className}`}
    >
      <Icon className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-medium">{copy.title}</p>
        <p className="text-muted-foreground leading-relaxed">{copy.body}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {showRetry && (
            <Button size="sm" variant="outline" onClick={onRetry} type="button">
              Try again
            </Button>
          )}
          <Button size="sm" variant={showRetry ? "text" : "outline"} href={copy.ctaHref}>
            {copy.ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AiUnavailableNotice;
