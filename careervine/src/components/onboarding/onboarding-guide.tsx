"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { GripHorizontal, Copy, Check, ExternalLink } from "lucide-react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";
import { useAuth } from "@/components/auth-provider";
import { ONBOARDING_STEPS } from "@/components/onboarding/onboarding-steps";
import { getOnboardingTranscript } from "@/components/onboarding/transcript-content";

const TOTAL_STEPS = ONBOARDING_STEPS.length;

/**
 * OnboardingGuide is a draggable floating card rendered in the bottom-right
 * corner that guides users through the 14-step onboarding flow.
 *
 * Users can drag it by the header bar to reposition it if it covers UI they
 * need to interact with.
 */
export function OnboardingGuide() {
  const { isActive, currentStep, currentStepId, progress, advance, skip } = useOnboarding();
  const { user } = useAuth();

  const firstName = (user?.user_metadata?.first_name as string | undefined) ?? "You";

  // Draggable position. -1 on both axes means "use default bottom-right".
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -1, y: -1 });
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in event handlers
  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Expandable transcript area state
  const [copied, setCopied] = useState(false);

  // Reset position to default whenever the step changes
  const stepId = currentStep?.id ?? null;
  useEffect(() => {
    setPos({ x: -1, y: -1 });
  }, [stepId]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);

    const card = (e.currentTarget as HTMLElement).closest("[data-onboarding-guide]") as HTMLElement | null;
    if (!card) return;

    const rect = card.getBoundingClientRect();
    dragOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newX = e.clientX - dragOffsetRef.current.x;
      const newY = e.clientY - dragOffsetRef.current.y;
      setPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleCopyTranscript = useCallback(async () => {
    const transcript = getOnboardingTranscript(firstName);
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently ignore clipboard errors
    }
  }, [firstName]);

  const handlePrimaryAction = useCallback(() => {
    if (!currentStep?.primaryAction) return;
    const { href, action } = currentStep.primaryAction;
    if (href) {
      // External links open in a new tab; internal hrefs navigate the current page
      if (href.startsWith("http")) {
        window.open(href, "_blank");
      } else {
        window.location.assign(href);
      }
      return;
    }
    if (action === "connect_gmail") {
      window.location.assign("/api/gmail/auth");
      return;
    }
    if (action === "connect_calendar") {
      window.location.assign("/api/gmail/auth?scopes=calendar");
      return;
    }
  }, [currentStep]);

  const handleSecondaryAction = useCallback(() => {
    if (!currentStep?.secondaryAction) return;
    const { action } = currentStep.secondaryAction;
    if (action === "confirm") {
      advance();
      return;
    }
    if (action === "skip" || action === "skip_wispr") {
      advance(true);
      return;
    }
    if (action === "complete") {
      advance();
      return;
    }
  }, [currentStep, advance]);

  if (!isActive || !currentStep) return null;

  const stepNumber = ONBOARDING_STEPS.findIndex((s) => s.id === currentStepId) + 1;

  // Build card position styles
  const isPositioned = pos.x !== -1 && pos.y !== -1;
  const cardStyle: React.CSSProperties = isPositioned
    ? {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        right: "auto",
        bottom: "auto",
      }
    : {
        position: "fixed",
        bottom: 24,
        right: 24,
      };

  const hasPrimary = !!currentStep.primaryAction;
  const hasSecondary = !!currentStep.secondaryAction;
  const isExpandable = !!currentStep.expandable;

  const primaryLabel = currentStep.primaryAction?.label;
  const primaryHasExternal =
    currentStep.primaryAction?.href?.startsWith("http") ?? false;

  return (
    <div
      data-onboarding-guide
      style={{ ...cardStyle, width: 400, zIndex: 1000 }}
      className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden select-none"
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50 ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Getting Started
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium">
            {stepNumber}/{TOTAL_STEPS}
          </span>
          <GripHorizontal className="w-4 h-4 text-gray-400" />
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 flex flex-col gap-3">
        <div>
          <p className="text-lg font-bold text-gray-900 leading-snug">
            {currentStep.title}
          </p>
          <p className="text-sm text-gray-600 mt-1 leading-relaxed">
            {currentStep.description}
          </p>
        </div>

        {/* Action buttons */}
        {(hasPrimary || hasSecondary) && (
          <div className="flex items-center gap-2 mt-1">
            {hasPrimary && (
              <button
                type="button"
                onClick={handlePrimaryAction}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
              >
                {primaryLabel}
                {primaryHasExternal && <ExternalLink className="w-3.5 h-3.5" />}
              </button>
            )}
            {hasSecondary && (
              <button
                type="button"
                onClick={handleSecondaryAction}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
              >
                {currentStep.secondaryAction!.label}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Expandable transcript area (step 11 — paste_transcript) */}
      {isExpandable && (
        <div className="px-5 pb-4">
          <div className="relative">
            <div className="max-h-48 overflow-y-auto rounded-lg bg-gray-50 border border-gray-200 p-3 font-mono text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
              {getOnboardingTranscript(firstName)}
            </div>
            <button
              type="button"
              onClick={handleCopyTranscript}
              className="absolute top-2 right-2 p-1.5 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 transition-colors cursor-pointer"
              title="Copy transcript"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-600" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-gray-500" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Footer — progress bar + skip */}
      <div className="px-5 pb-4 flex flex-col gap-2">
        <div className="h-1 w-full rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <button
          type="button"
          onClick={() => skip()}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors text-left cursor-pointer w-fit"
        >
          Skip tutorial
        </button>
      </div>
    </div>
  );
}
