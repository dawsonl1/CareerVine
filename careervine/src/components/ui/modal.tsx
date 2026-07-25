"use client";

/**
 * M3 Dialog / Modal component
 *
 * Follows Material Design 3 dialog specs:
 *   - Scrim overlay at 32 % opacity
 *   - surface-container-high background
 *   - 28 px corner radius (M3 extra-large shape)
 *   - Headline in on-surface, body in on-surface-variant
 *   - Optional unsaved-changes guard on dismiss
 *
 * Focus (CAR-185): both surfaces here are real dialogs, and each traps its own
 * focus through useFocusTrap. They are DOM *siblings* rather than nested, so a
 * keydown inside the confirm dialog never bubbles through the modal surface and
 * the two traps compose with no trap stack and no "am I topmost" check.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";

/**
 * Elements that can hold keyboard focus.
 *
 * `[contenteditable]` is load-bearing: the compose modal's rich-text editor is a
 * contenteditable div rather than an <input>, so omitting it would drop the
 * editor out of the tab cycle entirely.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "summary",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

/**
 * Tabbable descendants of `root`, in document order.
 *
 * Filters on semantics rather than layout, deliberately. `offsetParent` and
 * `getClientRects()` are the usual way to drop invisible candidates, but jsdom
 * has no layout engine and returns null/empty for *every* element, so that
 * filter would empty the set and quietly disarm the trap under test while still
 * reading as correct. CSS visibility is instead an optional refinement via
 * `checkVisibility`, which jsdom does not implement, hence the `?? true`.
 * `checkOpacity` stays off: an `opacity: 0` control is still focusable.
 *
 * The tabindex check reads the *attribute*, not `el.tabIndex`. jsdom reports
 * tabIndex 0 for a disabled button and -1 for a contenteditable div, so trusting
 * the property would both admit disabled controls and drop the editor.
 */
function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) < 0) return false;
    if (el.hasAttribute("disabled") || el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest("[inert]")) return false;
    return el.checkVisibility?.({ checkVisibilityCSS: true }) ?? true;
  });
}

/**
 * Traps keyboard focus inside the returned ref's element while `active`, and
 * hands focus back to whatever opened it on close.
 *
 * Attach `onKeyDown` to the dialog surface and give that surface `tabIndex={-1}`
 * so it can hold focus when it has no focusable content of its own.
 *
 * Exported for `confirm-dialog.tsx` (CAR-188), which is a third dialog surface
 * in the same family. It imports rather than re-rolls because `tabbableWithin`
 * above is not the obvious implementation: the layout-free filter is what keeps
 * the trap armed under jsdom, and a fresh copy would reach for `offsetParent`
 * and silently disarm itself in exactly the tests written to prove it works.
 */
export function useFocusTrap(active: boolean) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    // Whatever opened this layer: the page's trigger for the modal, or a control
    // inside the modal for the confirm dialog.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const [firstTabbable] = tabbableWithin(surface);
    (firstTabbable ?? surface).focus();

    return () => {
      // isConnected skips a trigger that unmounted along with the dialog. It also
      // makes cleanup order irrelevant on the Discard path, where the confirm
      // dialog and the modal unmount in the same commit.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const surface = surfaceRef.current;
    if (!surface) return;

    // Recomputed per keypress rather than cached on open: these dialogs render
    // conditional controls, so a set captured at open goes stale.
    const tabbables = tabbableWithin(surface);
    if (tabbables.length === 0) {
      e.preventDefault();
      return;
    }

    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const focused = document.activeElement;

    // Only the edges are handled here. Everything in between is the browser's own
    // sequential navigation, which is already correct and which jsdom does not
    // implement, so faking it in a test would only assert the fake.
    if (e.shiftKey && (focused === first || focused === surface)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && focused === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return { surfaceRef, onKeyDown };
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /**
   * Accessible name for a modal with no visible `title`. A dialog must have a
   * name, and there is nothing to point `aria-labelledby` at without a title.
   * Ignored when `title` is set, where the headline supplies the name.
   */
  ariaLabel?: string;
  /** When true, dismissing via scrim/Escape/X shows a confirmation dialog */
  hasUnsavedChanges?: boolean;
  /** Custom message for the confirmation dialog */
  confirmMessage?: string;
}

/* ── Inline confirmation dialog ── */
function ConfirmDiscardDialog({
  message,
  onDiscard,
  onKeepEditing,
}: {
  message: string;
  onDiscard: () => void;
  onKeepEditing: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const { surfaceRef, onKeyDown } = useFocusTrap(true);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onKeepEditing} />
      <div
        ref={surfaceRef}
        onKeyDown={onKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="relative bg-surface-container-high rounded-[28px] shadow-xl max-w-sm w-full p-6 focus:outline-none"
      >
        <h3 id={titleId} className="text-base font-medium text-foreground mb-2">Unsaved changes</h3>
        <p id={messageId} className="text-sm text-muted-foreground mb-6">{message}</p>
        <div className="flex justify-end gap-2">
          {/* Keep editing leads in DOM order, so the trap's initial focus lands on
              it: APG says focus the least destructive action on an irreversible one. */}
          <button
            type="button"
            onClick={onKeepEditing}
            className="h-10 px-5 rounded-full text-sm font-medium text-primary hover:bg-primary/8 cursor-pointer transition-colors"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-10 px-5 rounded-full text-sm font-medium bg-error text-on-error hover:bg-error/90 cursor-pointer transition-colors"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export { ConfirmDiscardDialog };

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
  ariaLabel,
  hasUnsavedChanges = false,
  confirmMessage = "You have unsaved changes that will be lost.",
}: ModalProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const titleId = useId();
  const { surfaceRef, onKeyDown } = useFocusTrap(isOpen);

  const attemptClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  }, [hasUnsavedChanges, onClose]);

  const confirmDiscard = useCallback(() => {
    setShowConfirm(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirm) {
          setShowConfirm(false);
        } else {
          attemptClose();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, attemptClose, showConfirm]);

  // Reset confirm dialog when the modal closes. Adjusting state during render
  // (tracking the previous isOpen) is React's pattern for prop-driven resets.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) setShowConfirm(false);
  }

  if (!isOpen) return null;

  const sizeClasses: Record<string, string> = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* M3 Scrim */}
      <div
        className="absolute inset-0 bg-black/32"
        onClick={attemptClose}
      />

      {/* Dialog surface */}
      <div
        ref={surfaceRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={`relative w-full ${sizeClasses[size]} bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-hidden flex flex-col focus:outline-none`}
      >
        {/* Headline */}
        {title && (
          <div className="flex items-center justify-between px-6 pt-6 pb-4">
            <h2 id={titleId} className="text-[22px] leading-7 font-normal text-foreground">{title}</h2>
            <button
              type="button"
              onClick={attemptClose}
              aria-label="Close"
              className="state-layer p-2 -mr-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Body — headline supplies top spacing when present */}
        <div className={`flex-1 overflow-y-auto px-6 pb-6 ${title ? "" : "pt-6"}`}>
          {children}
        </div>
      </div>

      {/* Confirm discard dialog */}
      {showConfirm && (
        <ConfirmDiscardDialog
          message={confirmMessage}
          onDiscard={confirmDiscard}
          onKeepEditing={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
