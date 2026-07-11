"use client";

/**
 * CAR-26 — the single graceful-failure surface for AI features.
 *
 * Given an AiFailureCode, it renders the matching copy from AI_FAILURE_COPY
 * with a CTA to the Settings → AI tab (and a Retry when the failure is
 * retryable). Every AI feature drops this into its existing error region
 * instead of showing a raw string, so the token states read identically
 * everywhere. The one stateful case: ai_trial_expired (CAR-51) adds a
 * "Request AI access" action that asks the owner for a manual grant.
 */

import { useState } from "react";
import { Sparkles, AlertTriangle, CloudOff, Hourglass, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_FAILURE_COPY, type AiFailureCode } from "@/lib/ai-errors";

const ICONS: Record<AiFailureCode, typeof Sparkles> = {
  ai_no_key: Sparkles,
  ai_key_invalid: AlertTriangle,
  ai_quota_exhausted: AlertTriangle,
  ai_trial_expired: Hourglass,
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

type RequestAccessState = "idle" | "sending" | "sent" | "error";

/**
 * The "Request AI access" action for the trial-expired state (CAR-51): POSTs
 * the request (recorded + owner notified server-side) and settles into a
 * confirmation line. Shared by this notice and Settings → AI, so the flow
 * behaves identically wherever the locked state appears.
 */
export function RequestAiAccessButton({
  initialRequested = false,
}: {
  /** Start in the "request sent" state (e.g. settings knows a request is pending). */
  initialRequested?: boolean;
}) {
  const [state, setState] = useState<RequestAccessState>(initialRequested ? "sent" : "idle");

  async function requestAccess() {
    setState("sending");
    try {
      const res = await fetch("/api/ai/request-access", { method: "POST" });
      if (!res.ok) throw new Error(`request-access ${res.status}`);
      setState("sent");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <MailCheck className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
        Request sent. You&apos;ll get an email when it&apos;s enabled.
      </span>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="text"
        type="button"
        onClick={requestAccess}
        disabled={state === "sending"}
      >
        {state === "sending" ? "Sending…" : "Request AI access"}
      </Button>
      {state === "error" && (
        <span className="text-xs text-destructive">Couldn&apos;t send. Try again.</span>
      )}
    </>
  );
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
          {code === "ai_trial_expired" && <RequestAiAccessButton />}
        </div>
      </div>
    </div>
  );
}

export default AiUnavailableNotice;
