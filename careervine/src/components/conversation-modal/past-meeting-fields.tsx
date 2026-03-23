"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import TranscriptUploader from "@/components/transcript-uploader";
import { TranscriptActionSuggestions } from "@/components/meetings/transcript-action-suggestions";
import type { ParsedTranscriptTurn } from "@/lib/transcript-parser";
import type { ConversationFormState, PendingAction, TranscriptState } from "./types";

interface PastMeetingFieldsProps {
  form: ConversationFormState;
  setForm: React.Dispatch<React.SetStateAction<ConversationFormState>>;
  transcriptState: TranscriptState;
  setTranscriptState: React.Dispatch<React.SetStateAction<TranscriptState>>;
  /** Meeting ID (set in edit mode or after auto-save for AI extraction) */
  meetingId: number | null;
  userId: string;
  userName?: string;
  allContacts: { id: number; name: string }[];
  onAiActionAccepted: (action: PendingAction) => void;
  onActionCreated: () => void;
}

export function PastMeetingFields({
  form,
  setForm,
  transcriptState,
  setTranscriptState,
  meetingId,
  userId,
  userName,
  allContacts,
  onAiActionAccepted,
  onActionCreated,
}: PastMeetingFieldsProps) {
  const [showTranscript, setShowTranscript] = useState(!!form.transcript);

  const hasNotesOrTranscript = form.notes.trim().length > 0 || form.transcript.trim().length > 0;

  const attendees = form.selectedContactIds.map((id) => ({
    id,
    name: allContacts.find((c) => c.id === id)?.name || "",
  }));

  const handleSegmentsParsed = useCallback(
    (segments: ParsedTranscriptTurn[], source: string) => {
      setTranscriptState((prev) => ({
        ...prev,
        pendingSegments: segments,
        pendingTranscriptSource: source,
      }));
    },
    [setTranscriptState]
  );

  const handleAudioFile = useCallback(
    async (file: File) => {
      setTranscriptState((prev) => ({ ...prev, isTranscribing: true }));
      try {
        // Upload audio file
        const formDataUpload = new FormData();
        formDataUpload.append("file", file);
        const uploadRes = await fetch("/api/attachments/upload", {
          method: "POST",
          body: formDataUpload,
        });
        if (!uploadRes.ok) throw new Error("Upload failed");
        const { attachment } = await uploadRes.json();

        setTranscriptState((prev) => ({
          ...prev,
          pendingAudioAttachment: { id: attachment.id, object_path: attachment.object_path },
        }));

        // Transcribe
        const transcribeRes = await fetch("/api/transcripts/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objectPath: attachment.object_path }),
        });
        if (!transcribeRes.ok) throw new Error("Transcription failed");
        const { rawText, segments } = await transcribeRes.json();

        setForm((prev) => ({ ...prev, transcript: rawText }));
        setTranscriptState((prev) => ({
          ...prev,
          pendingSegments: segments || [],
          pendingTranscriptSource: "audio_deepgram",
          isTranscribing: false,
        }));
      } catch {
        setTranscriptState((prev) => ({ ...prev, isTranscribing: false }));
      }
    },
    [setForm, setTranscriptState]
  );

  return (
    <>
      {/* Notes */}
      <div>
        <label className={labelClasses}>
          Notes (optional)
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
          className={`${inputClasses} !h-auto py-3`}
          rows={3}
          placeholder="What did you discuss?"
        />
      </div>

      {/* Transcript (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setShowTranscript((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        >
          {showTranscript ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Transcript (optional)
        </button>
        {showTranscript && (
          <div className="mt-2">
            <TranscriptUploader
              value={form.transcript}
              onChange={(val) => setForm((prev) => ({ ...prev, transcript: val }))}
              onSegmentsParsed={handleSegmentsParsed}
              onAudioFile={handleAudioFile}
              isTranscribing={transcriptState.isTranscribing}
            />
          </div>
        )}
      </div>

      {/* AI Generate Action Items */}
      {meetingId ? (
        hasNotesOrTranscript && (
          <TranscriptActionSuggestions
            meetingId={meetingId}
            userId={userId}
            userName={userName}
            transcript={form.transcript || form.notes}
            attendees={attendees}
            meetingDate={form.date}
            onActionCreated={onActionCreated}
          />
        )
      ) : (
        <button
          type="button"
          disabled={!hasNotesOrTranscript}
          onClick={() => {/* Save first, then extract — handled by parent save flow */}}
          className="flex items-center gap-2 text-xs text-muted-foreground mt-2 cursor-not-allowed"
          title={hasNotesOrTranscript ? "Save the conversation first, then edit it to generate AI action items" : "Add notes or a transcript first"}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className={hasNotesOrTranscript ? "text-primary/50" : ""}>
            Suggest action items from transcript
          </span>
        </button>
      )}
    </>
  );
}
