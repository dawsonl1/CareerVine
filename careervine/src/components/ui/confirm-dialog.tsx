"use client";

/**
 * The styled replacement for `window.confirm` (CAR-188).
 *
 * CONVENTIONS.md §f says irreversible actions get a confirm modal. Twelve sites
 * used the native dialog instead: unstyled, unthemed, and on some browsers
 * suppressible ("don't let this page create more dialogs"), which turns a
 * destructive guard into a silent auto-yes.
 *
 * ── Why a promise, and not a declarative <ConfirmDialog isOpen> ───────────
 *
 * Every call site had the same shape, and it is the shape a blocking primitive
 * produces:
 *
 *   const handleDelete = async (id: number) => {
 *     if (!confirm("Delete this template?")) return;
 *     ...eight more statements...
 *   };
 *
 * A declarative dialog cannot preserve that. It would split each handler into a
 * half that opens the dialog and a half that runs on confirm, threading the id
 * through component state in between, at all twelve sites. One of them
 * (`app/meetings/page.tsx`, the action-item delete) is written inline inside a
 * JSX `onClick` and has no handler to split. Promise-shaped `confirm()` keeps
 * every body intact and costs one `await`:
 *
 *   if (!(await confirm("Delete this template?"))) return;
 *
 * So this is a hook returning a `confirm()` plus the node to render. The
 * `ConfirmDialog` underneath is exported too, for a caller that genuinely wants
 * to drive open state itself.
 *
 * ── The message prop is load-bearing ─────────────────────────────────────
 *
 * Eleven of the twelve sites passed a string literal, and a dialog designed
 * against only those could reasonably have hardcoded its copy. The twelfth,
 * `settings/provider-key-card.tsx`, passes `config.removeConfirm` from a
 * per-provider config object. `message` is required for that reason.
 */

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useDialogLayer, useFocusTrap } from "@/components/ui/modal";

export interface ConfirmOptions {
  /** The question. Required: one call site's copy is config-driven, not literal. */
  message: string;
  /** Headline above the message. Defaults to "Are you sure?". */
  title?: string;
  /** Confirm button copy. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button copy. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Styles the confirm action as destructive and makes the user's assent
   * deliberate rather than reflexive. Use for anything unrecoverable.
   */
  destructive?: boolean;
}

/**
 * The dialog surface. `role="alertdialog"` rather than `dialog` because it
 * interrupts the user for a consequential decision, which is exactly the
 * distinction APG draws between the two.
 */
export function ConfirmDialog({
  message,
  title = "Are you sure?",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const messageId = useId();
  const { surfaceRef, onKeyDown } = useFocusTrap(true);
  /**
   * This dialog is the reachable half of CAR-202: several call sites `confirm()` from
   * *inside* an open `Modal` (Edit Contact → Delete is the live one), and before the
   * layer stack that Escape cancelled the delete and dismissed the modal behind it in
   * the same keypress. Registering also gives it the scroll lock it never had.
   */
  const isTopLayer = useDialogLayer(true);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer()) onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel, isTopLayer]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/32" onClick={onCancel} />
      <div
        ref={surfaceRef}
        onKeyDown={onKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        data-testid="confirm-dialog"
        className="relative bg-surface-container-high rounded-[28px] shadow-xl max-w-sm w-full p-6 focus:outline-none"
      >
        <h2 id={titleId} className="text-base font-medium text-foreground mb-2">
          {title}
        </h2>
        <p id={messageId} className="text-sm text-muted-foreground mb-6">
          {message}
        </p>
        <div className="flex justify-end gap-2">
          {/* Cancel leads in DOM order so the trap's initial focus lands on it.
              APG: focus the least destructive action on an irreversible one. */}
          <button
            type="button"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
            className="h-10 px-5 rounded-full text-sm font-medium text-primary hover:bg-primary/8 cursor-pointer transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
            className={`h-10 px-5 rounded-full text-sm font-medium cursor-pointer transition-colors ${
              destructive
                ? "bg-error text-on-error hover:bg-error/90"
                : "bg-primary text-on-primary hover:bg-primary/90"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export interface UseConfirmResult {
  /**
   * Ask the user. Resolves true on confirm, false on cancel, Escape, scrim
   * click, or unmount. Accepts a bare string for the common case.
   */
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  /** Render this somewhere in the component's tree. Null while nothing is asked. */
  confirmDialog: ReactNode;
}

/**
 * Drop-in for `window.confirm`, minus the blocking.
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await confirm("Delete this interaction?"))) return;
 *   ...
 *   return (<>{confirmDialog}...</>);
 *
 * ── Why every exit path resolves ─────────────────────────────────────────
 *
 * `window.confirm` cannot fail to answer. This one can, and a promise that
 * never settles is worse than a wrong answer: the awaiting handler is suspended
 * forever, still holding whatever it took before the await. Several of these
 * handlers hold a `submittingRef` whose `finally` would never run, permanently
 * wedging the control against a second attempt. So an unmount resolves false
 * (task 3 of the CONVENTIONS §f contract: never leave a caller hanging), and a
 * second `confirm()` opened over a pending one resolves the first false rather
 * than dropping its resolver on the floor.
 */
export function useConfirm(): UseConfirmResult {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  /**
   * Authoritative holder of the live resolver; `pending` exists only to drive
   * the render. Resolving from inside a `setPending` updater would read
   * naturally and be wrong: React treats updaters as pure and double-invokes
   * them under StrictMode, so the settle would fire twice per click. It is also
   * what lets the unmount cleanup run on `[]` without a stale closure.
   */
  const pendingRef = useRef<PendingConfirm | null>(null);

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    return new Promise<boolean>((resolve) => {
      // The executor runs synchronously, so this is still inside the calling
      // handler's stack and setPending batches with it as usual.
      pendingRef.current?.resolve(false);
      const next: PendingConfirm = {
        options: typeof options === "string" ? { message: options } : options,
        resolve,
      };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    pendingRef.current?.resolve(confirmed);
    pendingRef.current = null;
    setPending(null);
  }, []);

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  return {
    confirm,
    confirmDialog: pending ? (
      <ConfirmDialog {...pending.options} onConfirm={onConfirm} onCancel={onCancel} />
    ) : null,
  };
}
