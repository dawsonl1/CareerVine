"use client";

import { useState, useEffect, useCallback } from "react";
import { Users, Sparkles, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SimpleContact } from "@/lib/types";

interface SpeakerMapping {
  speakerLabel: string;
  contactId: number | null;
  /** Confidence from AI matching (null = deterministic or manual) */
  confidence: number | null;
  /** Reasoning from AI matching */
  reason: string | null;
  /** Source of this mapping */
  source: "deterministic" | "ai" | "manual";
}

interface SpeakerResolverProps {
  /** Unique speaker labels from the parsed transcript */
  segments: { speaker_label: string; text?: string }[];
  /** Contacts associated with this meeting */
  meetingContacts: SimpleContact[];
  /** All user contacts (for broader matching) */
  allContacts?: SimpleContact[];
  /** Called when user confirms mappings */
  onResolve: (mappings: { speakerLabel: string; contactId: number | null }[]) => void;
  /** Called to dismiss without saving */
  onDismiss?: () => void;
  /** Meeting title for AI context */
  meetingTitle?: string;
}

/**
 * Auto-match speaker labels to contacts by name similarity.
 */
function autoMatch(
  speakerLabel: string,
  meetingContacts: SimpleContact[],
): number | null {
  const label = speakerLabel.toLowerCase().trim();

  // Exact match
  const exact = meetingContacts.find(
    (c) => c.name.toLowerCase() === label,
  );
  if (exact) return exact.id;

  // First-name match (only if unambiguous)
  const firstName = label.split(/\s+/)[0];
  if (firstName.length >= 2) {
    const matches = meetingContacts.filter(
      (c) => c.name.toLowerCase().startsWith(firstName),
    );
    if (matches.length === 1) return matches[0].id;
  }

  // Partial match -- speaker label contained in contact name or vice versa
  const partial = meetingContacts.filter(
    (c) =>
      c.name.toLowerCase().includes(label) ||
      label.includes(c.name.toLowerCase()),
  );
  if (partial.length === 1) return partial[0].id;

  // Email-based match
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const emailMatch = label.match(emailPattern);
  if (emailMatch) {
    const extractedEmail = emailMatch[0].toLowerCase();
    const emailContact = meetingContacts.find((c) => {
      const allEmails = [
        ...(c.emails || []),
        ...(c.email ? [c.email] : []),
      ].map((e) => e.toLowerCase());
      return allEmails.includes(extractedEmail);
    });
    if (emailContact) return emailContact.id;
  }

  return null;
}

/**
 * Extract sample text from segments for each speaker.
 * Takes the first 2-3 utterances per speaker, up to ~200 words.
 */
function extractSpeakerSamples(
  segments: { speaker_label: string; text?: string }[],
): Record<string, string> {
  const samples: Record<string, string> = {};
  const speakerCounts: Record<string, number> = {};

  for (const seg of segments) {
    const label = seg.speaker_label;
    if (!seg.text) continue;

    const count = speakerCounts[label] || 0;
    if (count >= 3) continue;

    const existing = samples[label] || "";
    const wordCount = existing.split(/\s+/).length;
    if (wordCount >= 200) continue;

    samples[label] = existing ? `${existing}\n${seg.text}` : seg.text;
    speakerCounts[label] = count + 1;
  }

  return samples;
}

/**
 * Confidence badge component.
 */
function ConfidenceBadge({ confidence, reason }: { confidence: number | null; reason: string | null }) {
  if (confidence === null) return null;

  let bgColor: string;
  let textColor: string;
  let label: string;

  if (confidence > 0.8) {
    bgColor = "bg-green-100 dark:bg-green-900/30";
    textColor = "text-green-700 dark:text-green-400";
    label = "High";
  } else if (confidence >= 0.5) {
    bgColor = "bg-yellow-100 dark:bg-yellow-900/30";
    textColor = "text-yellow-700 dark:text-yellow-400";
    label = "Medium";
  } else {
    bgColor = "bg-gray-100 dark:bg-gray-800/30";
    textColor = "text-gray-600 dark:text-gray-400";
    label = "Low";
  }

  return (
    <span className="relative group/badge inline-flex items-center gap-1">
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${bgColor} ${textColor}`}>
        {label}
        {reason && <Info className="h-2.5 w-2.5" />}
      </span>
      {reason && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 p-2 rounded-lg bg-gray-900 text-white text-[11px] leading-snug shadow-lg opacity-0 pointer-events-none group-hover/badge:opacity-100 group-hover/badge:pointer-events-auto transition-opacity z-10">
          {reason}
        </span>
      )}
    </span>
  );
}

export default function SpeakerResolver({
  segments,
  meetingContacts,
  allContacts,
  onResolve,
  onDismiss,
  meetingTitle,
}: SpeakerResolverProps) {
  const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker_label))];

  // Initialize mappings with deterministic auto-matching
  const [mappings, setMappings] = useState<SpeakerMapping[]>(() =>
    uniqueSpeakers.map((label) => {
      const matchedId = autoMatch(label, meetingContacts);
      return {
        speakerLabel: label,
        contactId: matchedId,
        confidence: matchedId ? 1.0 : null,
        reason: matchedId ? "Name match" : null,
        source: matchedId ? "deterministic" : "manual",
      };
    }),
  );

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Re-run auto-match if contacts change
  useEffect(() => {
    setMappings(
      uniqueSpeakers.map((label) => {
        const matchedId = autoMatch(label, meetingContacts);
        return {
          speakerLabel: label,
          contactId: matchedId,
          confidence: matchedId ? 1.0 : null,
          reason: matchedId ? "Name match" : null,
          source: matchedId ? "deterministic" : "manual",
        };
      }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingContacts.length]);

  const updateMapping = (speakerLabel: string, contactId: number | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.speakerLabel === speakerLabel
          ? { ...m, contactId, confidence: null, reason: null, source: "manual" as const }
          : m,
      ),
    );
  };

  // Check if there are unmatched speakers (for showing the AI button)
  const unmatchedCount = mappings.filter((m) => m.contactId === null).length;

  // Build contact context for AI matching
  const buildContactContext = useCallback(() => {
    const allContactsList = allContacts || meetingContacts;
    return allContactsList.map((c) => ({
      id: c.id,
      name: c.name,
      emails: [...(c.emails || []), ...(c.email ? [c.email] : [])].filter(Boolean),
    }));
  }, [allContacts, meetingContacts]);

  const handleAiMatch = useCallback(async () => {
    setAiLoading(true);
    setAiError(null);

    try {
      const speakerSamples = extractSpeakerSamples(segments);
      const contactContext = buildContactContext();
      const attendeeIds = meetingContacts.map((c) => c.id);

      // Only send unmatched speakers to AI
      const unmatchedLabels = mappings
        .filter((m) => m.contactId === null)
        .map((m) => m.speakerLabel);

      if (unmatchedLabels.length === 0) return;

      const res = await fetch("/api/transcripts/match-speakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speakerLabels: unmatchedLabels,
          speakerSamples,
          attendeeIds,
          contactContext,
          meetingTitle,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "AI matching failed");
      }

      const data = await res.json();
      const aiMatches: Array<{
        speakerLabel: string;
        contactId: number | null;
        confidence: number;
        reason: string;
      }> = data.matches || [];

      // Apply AI matches to current mappings
      setMappings((prev) =>
        prev.map((m) => {
          const aiMatch = aiMatches.find((am) => am.speakerLabel === m.speakerLabel);
          if (!aiMatch || !aiMatch.contactId) return m;

          // Pre-select high confidence (>0.8) and medium confidence (>=0.5)
          const shouldPreSelect = aiMatch.confidence >= 0.5;

          return {
            ...m,
            contactId: shouldPreSelect ? aiMatch.contactId : m.contactId,
            confidence: aiMatch.confidence,
            reason: aiMatch.reason,
            source: "ai" as const,
          };
        }),
      );
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI matching failed");
    } finally {
      setAiLoading(false);
    }
  }, [segments, mappings, meetingContacts, buildContactContext, meetingTitle]);

  // Other contacts not in this meeting (computed once for the dropdown)
  const meetingContactIds = new Set(meetingContacts.map((c) => c.id));
  const otherContacts = (allContacts || [])
    .filter((c) => !meetingContactIds.has(c.id))
    .slice(0, 50);

  if (uniqueSpeakers.length === 0) return null;

  return (
    <div className="border border-outline-variant rounded-[12px] p-4 space-y-3 bg-surface-container-low">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Users className="h-4 w-4" />
          Match speakers to contacts
        </div>
        {unmatchedCount > 0 && (
          <Button
            variant="tonal"
            size="sm"
            onClick={handleAiMatch}
            disabled={aiLoading}
          >
            {aiLoading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Auto-match with AI
              </>
            )}
          </Button>
        )}
      </div>

      {aiError && (
        <p className="text-xs text-destructive">{aiError}</p>
      )}

      <div className="space-y-2">
        {mappings.map((mapping) => (
          <div key={mapping.speakerLabel} className="flex items-center gap-3">
            <span className="text-sm text-foreground w-32 truncate flex-shrink-0">
              {mapping.speakerLabel}
            </span>
            <span className="text-xs text-muted-foreground">&rarr;</span>
            <select
              value={mapping.contactId ?? ""}
              onChange={(e) =>
                updateMapping(
                  mapping.speakerLabel,
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              className="flex-1 h-9 px-3 bg-surface-container-low text-foreground rounded-[4px] border border-outline text-sm focus:outline-none focus:border-primary"
            >
              <option value="">Unknown / Skip</option>
              {meetingContacts.length > 0 && (
                <optgroup label="Meeting attendees">
                  {meetingContacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherContacts.length > 0 && (
                <optgroup label="Other contacts">
                  {otherContacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {mapping.source === "ai" && (
              <ConfidenceBadge
                confidence={mapping.confidence}
                reason={mapping.reason}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="filled" size="sm" onClick={() => onResolve(mappings)}>
          Save mappings
        </Button>
        {onDismiss && (
          <Button variant="text" size="sm" onClick={onDismiss}>
            Skip
          </Button>
        )}
      </div>
    </div>
  );
}
