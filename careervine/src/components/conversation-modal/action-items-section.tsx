"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { inputClasses } from "@/lib/form-styles";
import type { PendingAction } from "./types";

interface ActionItemsSectionProps {
  pendingActions: PendingAction[];
  onAddAction: (action: PendingAction) => void;
  onRemoveAction: (index: number) => void;
}

export function ActionItemsSection({ pendingActions, onAddAction, onRemoveAction }: ActionItemsSectionProps) {
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [direction, setDirection] = useState<"my_task" | "waiting_on">("my_task");

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
    setDirection("my_task");
  }, [title, dueAt, direction, onAddAction]);

  return (
    <div className="border-t border-outline-variant pt-5">
      <label className="text-xs font-medium text-muted-foreground mb-2 block">
        Follow-ups
      </label>

      {/* Existing pending actions */}
      {pendingActions.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {pendingActions.map((action, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded-[8px] bg-surface-container-low">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
                action.direction === "waiting_on"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  : "bg-primary/10 text-primary"
              }`}>
                {action.direction === "waiting_on" ? "Waiting" : "My task"}
              </span>
              <span className="text-sm text-foreground flex-1 truncate">{action.title}</span>
              {action.dueAt && (
                <span className="text-xs text-muted-foreground shrink-0">
                  Due {new Date(action.dueAt + "T00:00:00").toLocaleDateString()}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemoveAction(i)}
                className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Direction toggle */}
      <div className="flex gap-1 mb-2">
        <button
          type="button"
          onClick={() => setDirection("my_task")}
          className={`text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-colors ${
            direction === "my_task"
              ? "bg-primary text-on-primary"
              : "bg-surface-container text-foreground hover:bg-surface-container-high"
          }`}
        >
          My task
        </button>
        <button
          type="button"
          onClick={() => setDirection("waiting_on")}
          className={`text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-colors ${
            direction === "waiting_on"
              ? "bg-amber-600 text-white dark:bg-amber-500"
              : "bg-surface-container text-foreground hover:bg-surface-container-high"
          }`}
        >
          Waiting on them
        </button>
      </div>

      {/* Add action item inline */}
      <div className="flex gap-2">
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
        <div className="w-[140px] shrink-0">
          <DatePicker value={dueAt} onChange={setDueAt} placeholder="Due date" />
        </div>
        <Button
          type="button"
          variant="tonal"
          size="sm"
          onClick={addAction}
          disabled={!title.trim()}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
