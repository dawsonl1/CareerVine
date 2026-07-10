"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  createResearchingNoteId,
  type PipelineResearchingNote,
} from "@/lib/pipeline-preview-storage";

const noteTextareaClassName =
  "w-full bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/60 resize-none overflow-hidden focus:outline-none leading-relaxed py-0.5";

function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  autoFocus,
  onKeyDown,
  onBlur,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={noteTextareaClassName}
    />
  );
}

function SavedNoteRow({
  note,
  onChange,
  onDelete,
}: {
  note: PipelineResearchingNote;
  onChange: (body: string) => void;
  onDelete: () => void;
}) {
  return (
    <li className="group relative pl-3 border-l-2 border-primary/25 hover:border-primary/40 pr-7">
      <AutoResizeTextarea value={note.body} onChange={onChange} placeholder="Note…" />
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete note"
        className="absolute right-0 top-0.5 p-1 rounded text-on-surface-variant opacity-0 group-hover:opacity-70 hover:!text-error hover:!opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 transition-opacity"
      >
        <X className="w-3 h-3" />
      </button>
    </li>
  );
}

function ComposeNoteRow({
  draft,
  onChange,
  onCommit,
  onDismiss,
}: {
  draft: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="pl-3 border-l-2 border-primary/50">
      <AutoResizeTextarea
        value={draft}
        onChange={onChange}
        placeholder="Recruiting intel for this scope…"
        autoFocus
        onBlur={() => {
          if (draft.trim()) onCommit();
          else onDismiss();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (draft.trim()) onCommit();
            else onDismiss();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onDismiss();
          }
        }}
      />
    </li>
  );
}

export function ResearchingNotesEditor({
  notes,
  onChange,
  intelNotes,
}: {
  notes: PipelineResearchingNote[];
  onChange: (notes: PipelineResearchingNote[]) => void;
  intelNotes?: Array<{ id: number; note: string }>;
}) {
  const [isComposing, setIsComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const saveDraft = () => {
    const body = draft.trim();
    if (!body) return;
    onChange([...notes, { id: createResearchingNoteId(), body }]);
    setDraft("");
    setIsComposing(false);
  };

  const cancelDraft = () => {
    setDraft("");
    setIsComposing(false);
  };

  const updateNote = (id: string, body: string) => {
    onChange(notes.map((n) => (n.id === id ? { ...n, body } : n)));
  };

  const deleteNote = (id: string) => {
    onChange(notes.filter((n) => n.id !== id));
  };

  const showIntel = intelNotes && intelNotes.length > 0 && notes.length === 0 && !isComposing;

  return (
    <div className="space-y-2">
      {(notes.length > 0 || isComposing) && (
        <ul className="space-y-3">
          {notes.map((note) => (
            <SavedNoteRow
              key={note.id}
              note={note}
              onChange={(body) => updateNote(note.id, body)}
              onDelete={() => deleteNote(note.id)}
            />
          ))}
          {isComposing && (
            <ComposeNoteRow
              draft={draft}
              onChange={setDraft}
              onCommit={saveDraft}
              onDismiss={cancelDraft}
            />
          )}
        </ul>
      )}

      {!isComposing && (
        <button
          type="button"
          onClick={() => setIsComposing(true)}
          className="inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-0.5 -ml-0.5"
        >
          <Plus className="w-3.5 h-3.5" />
          {notes.length === 0 ? "Add note" : "Add another note"}
        </button>
      )}

      {showIntel && (
        <div className="pt-1 space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
            From your target record
          </p>
          <ul className="space-y-2">
            {intelNotes.map((n) => (
              <li
                key={n.id}
                className="text-xs text-on-surface pl-3 border-l-2 border-outline-variant/50 leading-relaxed"
              >
                {n.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
