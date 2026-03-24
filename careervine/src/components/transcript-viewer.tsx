"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TranscriptSegment } from "@/lib/types";

// Speaker colors — small M3-friendly palette
const SPEAKER_COLORS = [
  "text-primary",
  "text-tertiary",
  "text-error",
  "text-secondary",
  "text-[#7B5EA7]",
  "text-[#5B7553]",
];

function formatTime(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface TranscriptViewerProps {
  /** Parsed segments (from transcript_segments table) */
  segments?: TranscriptSegment[];
  /** Raw transcript text fallback (for meetings without parsed segments) */
  rawText?: string | null;
  /** Maximum segments to show before "Show more" */
  initialLimit?: number;
}

export default function TranscriptViewer({
  segments,
  rawText,
  initialLimit = 8,
}: TranscriptViewerProps) {
  const [expanded, setExpanded] = useState(false);

  // Fallback to raw text if no parsed segments
  if (!segments?.length) {
    if (!rawText) return null;
    return (
      <div className="bg-surface-container-low rounded-[14px] p-5 max-h-56 overflow-y-auto">
        <p className="whitespace-pre-wrap text-base text-foreground leading-relaxed">{rawText}</p>
      </div>
    );
  }

  // Build speaker → color map
  const speakerColorMap = new Map<string, string>();
  const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker_label))];
  uniqueSpeakers.forEach((speaker, i) => {
    speakerColorMap.set(speaker, SPEAKER_COLORS[i % SPEAKER_COLORS.length]);
  });

  const visibleSegments = expanded ? segments : segments.slice(0, initialLimit);
  const hasMore = segments.length > initialLimit;

  return (
    <div className="bg-surface-container-low rounded-[14px] p-5 space-y-4 max-h-[450px] overflow-y-auto">
      {visibleSegments.map((segment, i) => {
        const color = speakerColorMap.get(segment.speaker_label) || "text-foreground";
        const time = formatTime(segment.started_at);
        const contactName = segment.contacts?.name;

        return (
          <div key={segment.id ?? i} className="flex gap-2.5">
            <div className="flex-shrink-0 w-28">
              <span className={`text-sm font-semibold ${color} block truncate`}>
                {contactName || segment.speaker_label}
              </span>
              {time && (
                <span className="text-xs text-muted-foreground">{time}</span>
              )}
            </div>
            <p className="text-base text-foreground leading-relaxed flex-1">{segment.content}</p>
          </div>
        );
      })}

      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" /> Show {segments.length - initialLimit} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
