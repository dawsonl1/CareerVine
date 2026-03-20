import { useRef, useCallback, useEffect } from "react";
import { useToast } from "@/components/ui/toast";

interface DeferredActionOptions<T extends { id: number }> {
  action: (item: T) => Promise<void>;
  undoMessage: string | ((item: T) => string);
  delayMs?: number;
  onUndo?: (item: T) => void;
  onCommit?: (item: T) => void;
  onError?: (item: T, error: Error) => void;
  toastVariant?: "success" | "info" | "warning";
  extraActions?: (item: T) => { label: string; onClick: () => void }[];
}

export function useDeferredAction<T extends { id: number }>({
  action,
  undoMessage,
  delayMs = 5000,
  onUndo,
  onCommit,
  onError,
  toastVariant = "success",
  extraActions,
}: DeferredActionOptions<T>) {
  const pendingRef = useRef<Map<number, { item: T; timerId: ReturnType<typeof setTimeout> }>>(new Map());
  const { toast, dismiss } = useToast();

  // On unmount, commit all pending actions immediately
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const [, { item, timerId }] of pending) {
        clearTimeout(timerId);
        action(item).catch(() => {});
      }
      pending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const execute = useCallback((item: T) => {
    // If already pending for this id, clear the old timer
    const existing = pendingRef.current.get(item.id);
    if (existing) {
      clearTimeout(existing.timerId);
    }

    const message = typeof undoMessage === "function" ? undoMessage(item) : undoMessage;

    const toastId = toast(message, {
      variant: toastVariant,
      duration: delayMs,
      showProgress: true,
      actions: [
        ...(extraActions?.(item) ?? []),
        {
          label: "Undo",
          onClick: () => {
            const entry = pendingRef.current.get(item.id);
            if (entry) {
              clearTimeout(entry.timerId);
              pendingRef.current.delete(item.id);
            }
            dismiss(toastId);
            onUndo?.(item);
          },
        },
      ],
    });

    const timerId = setTimeout(async () => {
      pendingRef.current.delete(item.id);
      try {
        await action(item);
        onCommit?.(item);
      } catch (err) {
        onError?.(item, err as Error);
        // Restore on failure
        onUndo?.(item);
      }
    }, delayMs);

    pendingRef.current.set(item.id, { item, timerId });
  }, [action, undoMessage, delayMs, onUndo, onCommit, onError, toastVariant, extraActions, toast, dismiss]);

  const isPending = useCallback((id: number) => pendingRef.current.has(id), []);

  return { execute, isPending };
}
