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
import { useFocusTrap } from "@/components/ui/modal";

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

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    // Matches Modal (CAR-204). window.confirm froze the page; without this the
    // content scrolls behind the scrim, the one place this dialog still behaved
    // unlike the primitive it replaced.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [onCancel]);

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
  /** Monotonic, so a superseding question remounts the dialog rather than
   * reconciling into it. See the `key` at the bottom of `useConfirm`. */
  id: number;
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
 * never settles suspends the awaiting handler forever. So an unmount resolves
 * false, and a second `confirm()` opened over a pending one resolves the first
 * false rather than dropping its resolver on the floor.
 *
 * CAR-188 justified this by claiming several handlers hold a `submittingRef`
 * whose `finally` would never run. That was wrong, and is corrected here
 * (CAR-204): `confirm()` is the first awaited statement at all twelve sites, so
 * nothing is held across it and a hang would strand no lock. The defense is
 * still right — a suspended handler is a bug whether or not it holds a lock —
 * but the invariant below is the part that actually needs care.
 *
 * ── The one invariant a caller must hold ─────────────────────────────────
 *
 * `confirmDialog` must be rendered on EVERY return path of the component that
 * owns the hook. The unmount cleanup only fires when the hook itself unmounts;
 * if the host stays mounted while an early return stops rendering the node, the
 * promise never settles at all. Five adopters currently render it only on the
 * happy path — none reachable today, each one refactor away.
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
  const questionIdRef = useRef(0);

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
        id: ++questionIdRef.current,
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
      // Keyed so a supersede REMOUNTS instead of reconciling in place
      // (CAR-204). None of useFocusTrap's deps change on a supersede: `active`
      // is the literal `true` below, `returnFocusFallback` is not passed, and
      // `surface` is the same DOM node because reconciling in place is exactly
      // what happens without a key. So the trap effect never re-runs and
      // question 2 opens with focus wherever question 1 left it — possibly on
      // the destructive button, which is what the APG ordering above exists to
      // prevent.
      <ConfirmDialog key={pending.id} {...pending.options} onConfirm={onConfirm} onCancel={onCancel} />
    ) : null,
  };
}
