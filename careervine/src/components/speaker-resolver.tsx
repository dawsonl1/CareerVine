"use client";

import { useState, useEffect } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SimpleContact } from "@/lib/types";
import type { TranscriptSegment } from "@/lib/transcript-parser";

interface SpeakerMapping {
  speakerLabel: string;
  contactId: number | null;
}

interface SpeakerResolverProps {
  /** Unique speaker labels from the parsed transcript */
  segments: TranscriptSegment[];
  /** Contacts associated with this meeting */
  meetingContacts: SimpleContact[];
  /** All user contacts (for broader matching) */
  allContacts?: SimpleContact[];
  /** Called when user confirms mappings */
  onResolve: (mappings: SpeakerMapping[]) => void;
  /** Called to dismiss without saving */
  onDismiss?: () => void;
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

  // Partial match — speaker label contained in contact name or vice versa
  const partial = meetingContacts.filter(
    (c) =>
      c.name.toLowerCase().includes(label) ||
      label.includes(c.name.toLowerCase()),
  );
  if (partial.length === 1) return partial[0].id;

  return null;
}

export default function SpeakerResolver({
  segments,
  meetingContacts,
  allContacts,
  onResolve,
  onDismiss,
}: SpeakerResolverProps) {
  const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker_label))];

  // Initialize mappings with auto-matching
  const [mappings, setMappings] = useState<SpeakerMapping[]>(() =>
    uniqueSpeakers.map((label) => ({
      speakerLabel: label,
      contactId: autoMatch(label, meetingContacts),
    })),
  );

  // Re-run auto-match if contacts change
  useEffect(() => {
    setMappings(
      uniqueSpeakers.map((label) => ({
        speakerLabel: label,
        contactId: autoMatch(label, meetingContacts),
      })),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingContacts.length]);

  const updateMapping = (speakerLabel: string, contactId: number | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.speakerLabel === speakerLabel ? { ...m, contactId } : m,
      ),
    );
  };

  // Combine meeting contacts + all contacts, deduped, meeting contacts first
  const contactOptions = allContacts
    ? [
        ...meetingContacts,
        ...allContacts.filter((c) => !meetingContacts.some((mc) => mc.id === c.id)),
      ]
    : meetingContacts;

  if (uniqueSpeakers.length === 0) return null;

  return (
    <div className="border border-outline-variant rounded-[12px] p-4 space-y-3 bg-surface-container-low">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Users className="h-4 w-4" />
        Match speakers to contacts
      </div>

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
              {allContacts && allContacts.filter((c) => !meetingContacts.some((mc) => mc.id === c.id)).length > 0 && (
                <optgroup label="Other contacts">
                  {allContacts
                    .filter((c) => !meetingContacts.some((mc) => mc.id === c.id))
                    .slice(0, 50) // Limit dropdown size
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
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
