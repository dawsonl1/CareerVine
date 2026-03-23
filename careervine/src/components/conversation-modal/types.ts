import type { ParsedTranscriptTurn } from "@/lib/transcript-parser";

export type ConversationFormState = {
  selectedContactIds: number[];
  title: string;
  meetingType: string;
  date: string;
  time: string;
  notes: string;
  privateNotes: string;
  transcript: string;
  calendarDescription: string;
};

export type PendingAction = {
  title: string;
  dueAt: string;
  direction: "my_task" | "waiting_on";
  contactIds: number[];
  description: string | null;
  /** Set when accepted from AI suggestion */
  source?: "manual" | "ai_transcript";
  evidence?: string;
  assignedSpeaker?: string;
};

export type TranscriptState = {
  pendingSegments: ParsedTranscriptTurn[];
  pendingTranscriptSource: string | null;
  isTranscribing: boolean;
  pendingAudioAttachment: { id: number; object_path: string } | null;
};
