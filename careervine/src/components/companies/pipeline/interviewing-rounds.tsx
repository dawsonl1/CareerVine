"use client";

import { Plus, Trash2 } from "lucide-react";
import { ApplicationDatePicker } from "@/components/ui/application-date-picker";
import {
  createInterviewRoundId,
  type PipelineInterviewRound,
} from "@/lib/pipeline-state";

const inputClassName =
  "w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30";

const textareaClassName =
  "w-full px-3 py-2 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 resize-y min-h-[4.5rem]";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-on-surface-variant">{label}</label>
      {children}
    </div>
  );
}

function RoundCard({
  round,
  index,
  onChange,
  onDelete,
}: {
  round: PipelineInterviewRound;
  index: number;
  onChange: (patch: Partial<PipelineInterviewRound>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-high/25 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant pt-0.5">
          Round {index + 1}
        </p>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove round"
          className="p-1.5 rounded-md text-on-surface-variant/70 hover:text-error hover:bg-error-container/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <FieldRow label="Interview date">
        <ApplicationDatePicker
          value={round.date}
          onChange={(date) => onChange({ date })}
          placeholder="Select interview date"
          dialogTitle="Interview date"
          dialogDescription="When this interview is scheduled or took place"
        />
      </FieldRow>
      <FieldRow label="Interviewer">
        <input
          type="text"
          value={round.interviewer}
          onChange={(e) => onChange({ interviewer: e.target.value })}
          placeholder="Name"
          className={inputClassName}
        />
      </FieldRow>
      <FieldRow label="Interview notes">
        <textarea
          rows={2}
          value={round.questions}
          onChange={(e) => onChange({ questions: e.target.value })}
          placeholder="Notes from the interview…"
          className={textareaClassName}
        />
      </FieldRow>
    </div>
  );
}

export function InterviewingRoundsEditor({
  rounds,
  onChange,
}: {
  rounds: PipelineInterviewRound[];
  onChange: (rounds: PipelineInterviewRound[]) => void;
}) {
  const addRound = () => {
    onChange([
      ...rounds,
      {
        id: createInterviewRoundId(),
        date: "",
        interviewer: "",
        questions: "",
      },
    ]);
  };

  const updateRound = (id: string, patch: Partial<PipelineInterviewRound>) => {
    onChange(rounds.map((round) => (round.id === id ? { ...round, ...patch } : round)));
  };

  const deleteRound = (id: string) => {
    onChange(rounds.filter((round) => round.id !== id));
  };

  return (
    <div className="space-y-3">
      {rounds.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          Add a round when you schedule or complete an interview.
        </p>
      ) : (
        <ul className="space-y-3">
          {rounds.map((round, index) => (
            <li key={round.id}>
              <RoundCard
                round={round}
                index={index}
                onChange={(patch) => updateRound(round.id, patch)}
                onDelete={() => deleteRound(round.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addRound}
        className="inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-0.5 -ml-0.5"
      >
        <Plus className="w-3.5 h-3.5" />
        {rounds.length === 0 ? "Add round" : "Add another round"}
      </button>
    </div>
  );
}
