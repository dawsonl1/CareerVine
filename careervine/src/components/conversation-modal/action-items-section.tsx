"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { ActionDirection } from "@/lib/constants";
import type { PendingAction } from "./types";

interface ActionItemsSectionProps {
  pendingActions: PendingAction[];
  onAddAction: (action: PendingAction) => void;
  onRemoveAction: (index: number) => void;
}

export function ActionItemsSection({ pendingActions, onAddAction, onRemoveAction }: ActionItemsSectionProps) {
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [direction, setDirection] = useState<"my_task" | "waiting_on">(ActionDirection.MyTask);

  const addAction = useCallback(() => {
    if (!title.trim()) return;
    onAddAction({
      title: title.trim(),
      dueAt,
      direction,
      contactIds: [],
      description: null,
      source: "manual",
    });
    setTitle("");
    setDueAt("");
    setDirection(ActionDirection.MyTask);
  }, [title, dueAt, direction, onAddAction]);

  return (
    <div className="border-t border-outline-variant pt-6">
      <label className={labelClasses}>
        Follow-ups
      </label>

      {/* Existing pending actions */}
      {pendingActions.length > 0 && (
        <div className="space-y-2 mb-4">
          {pendingActions.map((action, i) => (
            <div key={i} className="flex items-center gap-2.5 p-3 rounded-[10px] bg-surface-container-low">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
                action.direction === ActionDirection.WaitingOn
                  ? "bg-tertiary-container text-on-tertiary-container"
                  : "bg-primary/10 text-primary"
              }`}>
                {action.direction === ActionDirection.WaitingOn ? "Waiting" : "My task"}
              </span>
              <span className="text-base text-foreground flex-1 truncate">{action.title}</span>
              {action.dueAt && (
                <span className="text-sm text-muted-foreground shrink-0">
                  Due {new Date(action.dueAt + "T00:00:00").toLocaleDateString()}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemoveAction(i)}
                className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Direction toggle */}
      <div className="flex gap-1.5 mb-2.5">
        <button
          type="button"
          onClick={() => setDirection(ActionDirection.MyTask)}
          className={`text-sm font-medium px-4 py-1.5 rounded-full cursor-pointer transition-colors ${
            direction === ActionDirection.MyTask
              ? "bg-primary text-on-primary"
              : "bg-surface-container text-foreground hover:bg-surface-container-high"
          }`}
        >
          My task
        </button>
        <button
          type="button"
          onClick={() => setDirection(ActionDirection.WaitingOn)}
          className={`text-sm font-medium px-4 py-1.5 rounded-full cursor-pointer transition-colors ${
            direction === ActionDirection.WaitingOn
              ? "bg-tertiary text-on-tertiary"
              : "bg-surface-container text-foreground hover:bg-surface-container-high"
          }`}
        >
          Waiting on them
        </button>
      </div>

      {/* Add action item inline */}
      <div className="flex gap-2.5 items-stretch">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addAction();
            }
          }}
          className={`${inputClasses} flex-1`}
          placeholder="Action item title"
        />
        <div className="w-[150px] shrink-0">
          <DatePicker value={dueAt} onChange={setDueAt} placeholder="Due date" />
        </div>
      </div>
      <button
        type="button"
        onClick={addAction}
        disabled={!title.trim()}
        className="mt-2.5 flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 disabled:text-muted-foreground disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        <Plus className="h-4 w-4" />
        Add follow-up
      </button>
    </div>
  );
}
