"use client";

import { useState } from "react";
import { X, ChevronDown, ChevronUp, AlertCircle, RefreshCw } from "lucide-react";
import { RichTextEditor } from "@/components/ui/rich-text-editor";

export interface FollowUpDraft {
  id: string;
  subject: string;
  bodyHtml: string;
  delayDays: number;
  projectedDate: string;
}

interface FollowUpPlanSectionProps {
  followUps: FollowUpDraft[];
  enabled: boolean;
  loading: boolean;
  error: string | null;
  placeholder: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: (id: string, updates: Partial<FollowUpDraft>) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
}

const DELAY_OPTIONS = [
  { label: "3 days", value: 3 },
  { label: "5 days", value: 5 },
  { label: "7 days", value: 7 },
  { label: "14 days", value: 14 },
  { label: "21 days", value: 21 },
  { label: "30 days", value: 30 },
];

export function FollowUpPlanSection({
  followUps,
  enabled,
  loading,
  error,
  placeholder,
  onToggle,
  onEdit,
  onRemove,
  onRetry,
}: FollowUpPlanSectionProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="mt-4 rounded-2xl bg-surface-container-low border border-outline-variant/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-foreground">Follow-up plan</span>
          {!placeholder && !loading && (
            <span className="text-[10px] text-muted-foreground bg-surface-container-highest px-2 py-0.5 rounded-full">
              AI-generated
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
            enabled ? "bg-primary" : "bg-outline-variant"
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4.5 right-0.5" : "left-0.5"
            }`}
            style={enabled ? { right: "2px", left: "auto" } : { left: "2px" }}
          />
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="px-5 pb-5">
          <div className="flex flex-col items-center py-6">
            <div className="w-36 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ animation: "followUpProgress 3s ease-in-out infinite" }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3 animate-pulse">
              Generating follow-ups...
            </p>
            <style>{`
              @keyframes followUpProgress {
                0% { width: 10%; }
                50% { width: 70%; }
                100% { width: 90%; }
              }
            `}</style>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2.5 p-3 rounded-xl bg-destructive/5 border border-destructive/10">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-destructive flex-1">{error}</span>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-primary hover:bg-primary/10 transition-colors cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Placeholder cards */}
      {placeholder && !loading && !error && (
        <div className="px-5 pb-4 space-y-2">
          {[7, 14, 21].map((days, i) => (
            <div
              key={days}
              className="flex items-center gap-3 p-3 rounded-xl bg-surface-container/50 border border-outline-variant/30"
            >
              <div className="w-6 h-6 rounded-full bg-surface-container-highest flex items-center justify-center text-[10px] font-semibold text-muted-foreground">
                {i + 1}
              </div>
              <div className="flex-1">
                <div className="text-xs font-medium text-muted-foreground/60">
                  {days} days after send
                </div>
                <div className="text-[11px] text-muted-foreground/40 mt-0.5">
                  Will be generated after you approve the intro
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Follow-up cards */}
      {!placeholder && !loading && !error && followUps.length > 0 && (
        <div className={`px-5 pb-4 space-y-2 ${!enabled ? "opacity-50" : ""}`}>
          {followUps.map((fu, i) => {
            const isExpanded = expandedId === fu.id;
            return (
              <div
                key={fu.id}
                className={`rounded-xl border transition-colors ${
                  isExpanded
                    ? "border-primary/30 bg-white"
                    : "border-outline-variant/30 bg-white hover:border-outline-variant/60"
                }`}
              >
                {/* Collapsed header — always visible */}
                <div
                  className="flex items-center gap-3 p-3 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : fu.id)}
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                      isExpanded
                        ? "bg-primary text-primary-foreground"
                        : "bg-primary/10 text-primary"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      {fu.projectedDate}
                    </div>
                    {!isExpanded && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                        {fu.bodyHtml.replace(/<[^>]*>/g, "").substring(0, 120)}
                        {fu.bodyHtml.replace(/<[^>]*>/g, "").length > 120 ? "..." : ""}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(fu.id);
                      }}
                      className="p-1 rounded-full text-muted-foreground/50 hover:text-destructive hover:bg-destructive/5 transition-colors cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded editing */}
                {isExpanded && (
                  <div className="px-3 pb-3 border-t border-outline-variant/20">
                    <div className="mt-3">
                      <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                        Subject
                      </label>
                      <input
                        type="text"
                        value={fu.subject}
                        onChange={(e) => onEdit(fu.id, { subject: e.target.value })}
                        className="w-full h-8 px-2.5 rounded-lg border border-outline-variant/50 bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="mt-2.5">
                      <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                        Body
                      </label>
                      <div className="rounded-lg border border-outline-variant/50 bg-surface-container-low overflow-hidden">
                        <RichTextEditor
                          content={fu.bodyHtml}
                          onChange={(html) => onEdit(fu.id, { bodyHtml: html })}
                          placeholder="Follow-up email body..."
                        />
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <label className="text-[11px] text-muted-foreground">Send after</label>
                      <select
                        value={fu.delayDays}
                        onChange={(e) =>
                          onEdit(fu.id, { delayDays: Number(e.target.value) })
                        }
                        className="h-7 px-2 rounded-lg border border-outline-variant/50 bg-surface-container-low text-xs text-foreground focus:outline-none focus:border-primary"
                      >
                        {DELAY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer note */}
      {!loading && (
        <div className="px-5 pb-3.5">
          <p className="text-[11px] text-muted-foreground">
            Auto-cancels if they reply.
          </p>
        </div>
      )}
    </div>
  );
}
