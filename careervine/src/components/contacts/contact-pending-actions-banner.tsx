"use client";

import { CheckSquare } from "lucide-react";
import { updateActionItem } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";

type ActionItem = {
  id: number;
  title: string;
  due_at: string | null;
  is_completed: boolean;
};

interface ContactPendingActionsBannerProps {
  actions: ActionItem[];
  onActionCompleted: () => void;
  onViewAll: () => void;
}

export function ContactPendingActionsBanner({
  actions,
  onActionCompleted,
  onViewAll,
}: ContactPendingActionsBannerProps) {
  const { success: toastSuccess, error: toastError } = useToast();

  if (actions.length === 0) return null;

  const handleComplete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await updateActionItem(id, { is_completed: true, completed_at: new Date().toISOString() });
      toastSuccess("Action item completed");
      onActionCompleted();
    } catch {
      toastError("Failed to complete action item");
    }
  };

  const shown = actions.slice(0, 3);
  const remaining = actions.length - shown.length;

  return (
    <div className="mb-4 p-3 rounded-[12px] bg-primary-container/20 border border-primary/10">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <CheckSquare className="h-3.5 w-3.5 text-primary" />
          {actions.length} pending action{actions.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={onViewAll}
          className="text-xs text-primary font-medium hover:underline cursor-pointer"
        >
          View all
        </button>
      </div>
      <div className="space-y-1">
        {shown.map((item) => {
          const todayStr = new Date().toISOString().split("T")[0];
          const overdue = item.due_at && item.due_at.split("T")[0] < todayStr;
          return (
            <div key={item.id} className="flex items-center gap-2 group">
              <button
                onClick={(e) => handleComplete(e, item.id)}
                className="w-4 h-4 rounded border border-outline-variant hover:border-primary hover:bg-primary-container flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                title="Mark done"
              >
                <span className="hidden group-hover:block text-primary text-[10px]">✓</span>
              </button>
              <span className="text-xs text-foreground truncate flex-1">{item.title}</span>
              {item.due_at && (
                <span className={`text-[10px] shrink-0 ${overdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                  {overdue ? "Overdue" : `Due ${new Date(item.due_at).toLocaleDateString()}`}
                </span>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <p className="text-[10px] text-muted-foreground pl-6">+{remaining} more</p>
        )}
      </div>
    </div>
  );
}
