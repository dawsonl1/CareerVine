"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import TranscriptUploader from "@/components/transcript-uploader";
import { TranscriptActionSuggestions } from "@/components/meetings/transcript-action-suggestions";
import type { ParsedTranscriptTurn } from "@/lib/transcript-parser";
import type { ConversationFormState, PendingAction, TranscriptState } from "./types";
import { apiFetch, isApiRequestError, jsonBody } from "@/lib/api-client";
import { uploadAttachment } from "@/lib/queries";

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
  onActionCreated,
}: PastMeetingFieldsProps) {
  const [showTranscript, setShowTranscript] = useState(!!form.transcript);
  const [transcribeError, setTranscribeError] = useState("");

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
      setTranscribeError("");
      setTranscriptState((prev) => ({ ...prev, isTranscribing: true }));
      try {
        // CAR-237: upload through the shared client-side helper, the same path
        // every other uploader uses (meetings page, contact attachments). This
        // previously POSTed to /api/attachments/upload, a route that does not
        // exist, so audio selection 404'd before Deepgram was ever reached.
        const attachment = await uploadAttachment(userId, file);

        setTranscriptState((prev) => ({
          ...prev,
          pendingAudioAttachment: { id: attachment.id, object_path: attachment.object_path },
        }));

        // Transcribe — the server routes through the user's Deepgram key (or the
        // shared key) and returns a friendly, specific message if both fail.
        //
        // The body key must stay `attachmentObjectPath`: that is what
        // transcribeSchema requires, and sending `objectPath` (as this did
        // before CAR-237) is a silent 400. transcribe-payload-contract.test.ts
        // pins this against the route's own schema so a rename cannot drift.
        const { rawText, segments } = await apiFetch<{
          rawText: string;
          segments?: ParsedTranscriptTurn[];
        }>(
          "/api/transcripts/transcribe",
          jsonBody({ attachmentObjectPath: attachment.object_path }),
        );

        setForm((prev) => ({ ...prev, transcript: rawText }));
        setTranscriptState((prev) => ({
          ...prev,
          pendingSegments: segments || [],
          pendingTranscriptSource: "audio_deepgram",
          isTranscribing: false,
        }));
      } catch (err) {
        setTranscribeError(
          isApiRequestError(err) ? err.message : "Transcription failed. Please try again.",
        );
        setTranscriptState((prev) => ({ ...prev, isTranscribing: false }));
      }
    },
    [setForm, setTranscriptState, userId]
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
          className={`${inputClasses} !h-auto py-4`}
          rows={3}
          placeholder="What did you discuss?"
        />
      </div>

      {/* Transcript (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setShowTranscript((prev) => !prev)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        >
          {showTranscript ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          Transcript (optional)
        </button>
        {showTranscript && (
          <div className="mt-2.5">
            <TranscriptUploader
              value={form.transcript}
              onChange={(val) => setForm((prev) => ({ ...prev, transcript: val }))}
              onSegmentsParsed={handleSegmentsParsed}
              onAudioFile={handleAudioFile}
              isTranscribing={transcriptState.isTranscribing}
            />
            {transcribeError && (
              <p className="mt-2 text-sm text-destructive">{transcribeError}</p>
            )}
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
        <span
          className={`flex items-center gap-2.5 text-sm mt-2.5 ${
            hasNotesOrTranscript ? "text-primary/50" : "text-muted-foreground/50"
          }`}
          title={hasNotesOrTranscript ? "Save the conversation first, then edit it to generate AI action items" : "Add notes or a transcript first"}
        >
          <Sparkles className="h-4 w-4" />
          Suggest action items from transcript
        </span>
      )}
    </>
  );
}
