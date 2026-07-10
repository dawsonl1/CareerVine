"use client";

import { Plus, Trash2 } from "lucide-react";
import { ApplicationsOpenPicker } from "@/components/ui/applications-open-picker";
import {
  createResearchingProgramId,
  type PipelineResearchingProgram,
} from "@/lib/pipeline-preview-storage";

const inputClassName =
  "w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-on-surface-variant">{label}</label>
      {children}
    </div>
  );
}

function ProgramCard({
  program,
  index,
  onChange,
  onDelete,
}: {
  program: PipelineResearchingProgram;
  index: number;
  onChange: (patch: Partial<PipelineResearchingProgram>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-high/25 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant pt-0.5">
          Program {index + 1}
        </p>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove program"
          className="p-1.5 rounded-md text-on-surface-variant/70 hover:text-error hover:bg-error-container/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <FieldRow label="Role or program">
        <input
          type="text"
          value={program.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. IB Analyst, S&T Summer"
          className={inputClassName}
        />
      </FieldRow>
      <FieldRow label="Applications open">
        <ApplicationsOpenPicker
          value={program.appsOpen}
          onChange={(appsOpen) => onChange({ appsOpen })}
          placeholder="When do applications open?"
        />
      </FieldRow>
      <FieldRow label="Job potential (/10)">
        <input
          type="text"
          inputMode="numeric"
          value={program.jobPotential}
          onChange={(e) => onChange({ jobPotential: e.target.value })}
          placeholder="—"
          className={inputClassName}
        />
      </FieldRow>
    </div>
  );
}

export function ResearchingProgramsEditor({
  programs,
  onChange,
}: {
  programs: PipelineResearchingProgram[];
  onChange: (programs: PipelineResearchingProgram[]) => void;
}) {
  const addProgram = () => {
    onChange([
      ...programs,
      {
        id: createResearchingProgramId(),
        name: "",
        appsOpen: "",
        jobPotential: "",
      },
    ]);
  };

  const updateProgram = (id: string, patch: Partial<PipelineResearchingProgram>) => {
    onChange(programs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const deleteProgram = (id: string) => {
    onChange(programs.filter((p) => p.id !== id));
  };

  return (
    <div className="space-y-3">
      {programs.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          Add each role or program you&apos;re considering at this company.
        </p>
      ) : (
        <ul className="space-y-3">
          {programs.map((program, index) => (
            <li key={program.id}>
              <ProgramCard
                program={program}
                index={index}
                onChange={(patch) => updateProgram(program.id, patch)}
                onDelete={() => deleteProgram(program.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addProgram}
        className="inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-0.5 -ml-0.5"
      >
        <Plus className="w-3.5 h-3.5" />
        {programs.length === 0 ? "Add program" : "Add another program"}
      </button>
    </div>
  );
}
