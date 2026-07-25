"use client";

/**
 * M3 Dialog / Modal component
 *
 * Two layers live here (CAR-197):
 *
 *   `DialogSurface` is what makes something a dialog — the trap, the layer
 *   registration, Escape, the ARIA, the unsaved-changes guard, and the portal
 *   context. It renders whatever chrome the caller hands it.
 *
 *   `Modal` is the M3 chrome — scrim, 28px surface, headline row with a close X,
 *   padded scrolling body — over a `DialogSurface`. Most dialogs want this one.
 *
 * The split exists because four dialogs cannot use `Modal`'s chrome and were
 * hand-rolled instead, which is how they ended up with no trap and no dialog
 * semantics at all. Compose and follow-up are header / scrolling middle / sticky
 * footer, which `Modal`'s single scrolling body cannot express; the conversation
 * modal is a bottom sheet on mobile; guided onboarding is deliberately not
 * dismissible. Each of those now supplies its own chrome to `DialogSurface`
 * rather than re-deriving what a dialog is.
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
 * the two TAB traps compose with no trap stack and no "am I topmost" check.
 *
 * Dismissal (CAR-202) is the opposite: Escape is a *document*-level event, so every
 * open layer's listener sees every keypress and one press dismissed the whole stack.
 * That one does need a topmost check, and `useDialogLayer` below is it — shared with
 * the other dialog surfaces in the app rather than kept private here.
 *
 * Portalled children (CAR-198): the trap is "everything inside the surface", so a
 * child that portals out of the surface leaves the cycle and becomes keyboard
 * unreachable. Rather than teach the trap about satellite containers, the surface
 * publishes itself through `useModalPortalContainer` and such children portal
 * *into* it — see the note on that hook for what keeps that visually safe.
 */

import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { X } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

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
 *
 * The surface is held in state behind a callback ref rather than in a `useRef`,
 * because it is published to descendants as a portal target and so has to be
 * readable during render. `ref.current` would be populated by the time any menu
 * opens, but reading it in render is impure and would not re-render a consumer.
 * `setSurface` is used as the ref directly: `useState` guarantees it is stable,
 * and a DOM node can never be mistaken for a functional updater. Callers that
 * only attach it to a `<div ref=>` are unaffected by the change.
 *
 * `returnFocusFallback` is optional and where focus goes when the element that
 * opened this layer is no longer a usable target. A layer that closes without
 * landing focus somewhere real leaves it on `<body>`, and since the trap is a
 * keydown handler *on the surface*, focus outside the surface means the trap
 * silently stops running and Tab walks straight out of the dialog.
 */
export function useFocusTrap(active: boolean, returnFocusFallback?: HTMLElement | null) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active || !surface) return;

    // Whatever opened this layer: the page's trigger for the modal, or a control
    // inside the modal for the confirm dialog.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const tabbables = tabbableWithin(surface);
    // `data-autofocus` names the control a form dialog should open on, the way
    // native `<dialog>.showModal()` honours `autofocus`. React's `autoFocus` prop
    // cannot serve here: React strips the attribute and calls `.focus()` itself
    // during commit, so nothing is left in the DOM to find and this effect —
    // which runs after — silently focused the close button instead. That had been
    // true of every `autoFocus` inside a Modal since the trap landed (CAR-197).
    // Read off the tabbable set rather than queried directly, so a marker on a
    // hidden or disabled control falls through instead of black-holing focus.
    const preferred = tabbables.find((el) => el.hasAttribute("data-autofocus"));
    (preferred ?? tabbables[0] ?? surface).focus();

    return () => {
      // isConnected skips a trigger that unmounted along with the dialog. It also
      // makes cleanup order irrelevant on the Discard path, where the confirm
      // dialog and the modal unmount in the same commit.
      //
      // <body> is treated as "nothing to restore" rather than a target: a scrim
      // mousedown blurs to <body> before this captures, and focusing it drops the
      // user at the top of the document. The fallback then covers a layer that
      // opened over a live one — the confirm dialog can capture an open Select's
      // option as its `previouslyFocused`, and that option is gone by the time it
      // closes, so without this focus would land nowhere inside a modal that is
      // still open.
      if (previouslyFocused?.isConnected && previouslyFocused !== document.body) {
        previouslyFocused.focus();
      } else if (returnFocusFallback?.isConnected) {
        (tabbableWithin(returnFocusFallback)[0] ?? returnFocusFallback).focus();
      }
    };
  }, [active, surface, returnFocusFallback]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    if (!surface) return;

    // Recomputed per keypress rather than cached on open: these dialogs render
    // conditional controls, so a set captured at open goes stale. An open Select
    // menu is the extreme case — it appears and vanishes mid-cycle.
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
  }, [surface]);

  return { surfaceRef: setSurface, surface, onKeyDown };
}

/* ── Dismissal layer stack ── */

/** Every open modal layer, oldest first. Identity only; no layer reads another's. */
const layerStack: symbol[] = [];

/** Body `overflow` as it stood before the first layer locked it. */
let overflowBeforeLock = "";

/**
 * Registers an open dialog as a modal layer and reports whether it is the topmost.
 *
 * Every dialog in this app listens for Escape on `document`/`window`, and a
 * document-level listener fires for every layer regardless of which one is on top, so
 * one keypress used to dismiss the entire stack. The reachable case is the page-level
 * `ConfirmDialog` that Edit Contact's Delete opens over the still-open modal: Escape
 * there cancelled the delete *and* closed the modal underneath it (CAR-202).
 *
 * `isTopLayer` is a function, not a boolean, because the answer has to be read when
 * the key is pressed rather than when the listener was attached. A layer that is
 * topmost at effect time stops being topmost the moment another opens above it, and
 * nothing re-runs its effect to tell it so.
 *
 * The stack also owns the body scroll lock, because "should the page be locked" is
 * the same question as "is any layer open". Each dialog releasing its own lock meant
 * the first one to unmount unlocked the page under everything still open. What was
 * there before is captured and restored, rather than assumed to be `"unset"`.
 *
 * A dialog rendered *inside* another as its own confirmation step should not register
 * — see the note on `ConfirmDiscardDialog`.
 */
export function useDialogLayer(active: boolean): () => boolean {
  const [id] = useState(() => Symbol("dialog-layer"));

  useEffect(() => {
    if (!active) return;

    if (layerStack.length === 0) {
      overflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    layerStack.push(id);

    return () => {
      const at = layerStack.lastIndexOf(id);
      if (at !== -1) layerStack.splice(at, 1);
      if (layerStack.length === 0) document.body.style.overflow = overflowBeforeLock;
    };
  }, [active, id]);

  return useCallback(() => layerStack[layerStack.length - 1] === id, [id]);
}

interface ModalContextValue {
  /** The dialog surface, or null outside a Modal. */
  portalContainer: HTMLElement | null;
  /** Close, routed through the unsaved-changes guard. No-op outside a Modal. */
  dismiss: () => void;
}

const ModalContext = createContext<ModalContextValue>({ portalContainer: null, dismiss: () => {} });

/**
 * Portal target for a modal child that must escape an `overflow` ancestor — a
 * dropdown menu, a popover — without escaping the focus trap. Returns the dialog
 * surface inside a Modal and `null` outside one, so the caller's fallback is the
 * usual `?? document.body`.
 *
 * This works because the surface is `overflow: hidden` but the things portalled
 * into it are `position: fixed`, and a fixed element's containing block is the
 * viewport, so ancestor overflow never clips it. That holds only while the
 * surface forms no containing block for fixed descendants: a `transform`,
 * `filter`, `backdrop-filter`, `perspective`, `contain` (of `layout`/`paint`/
 * `strict`/`content`), `container-type`, or a `will-change` naming one of those,
 * on it or on the wrapper around it, would silently start clipping every menu
 * inside every modal. An entrance animation is the obvious way that happens, so
 * `careervine/src/__tests__/modal.test.tsx` pins both elements against it.
 *
 * Not covered by that tripwire, because Tailwind has no first-class utility for
 * it: `clip-path` on an ancestor clips fixed descendants through a different
 * mechanism, without establishing a containing block.
 */
export function useModalPortalContainer(): HTMLElement | null {
  return useContext(ModalContext).portalContainer;
}

/**
 * Dismiss the enclosing Modal through its unsaved-changes guard, for a footer
 * Cancel button. Calling the caller's own `onClose` there instead bypasses the
 * confirmation that the scrim, Escape and the X all honour, so a modal that sets
 * `hasUnsavedChanges` would warn on three dismissal paths and silently discard on
 * the fourth.
 */
export function useModalDismiss(): () => void {
  return useContext(ModalContext).dismiss;
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The headline, and the dialog's accessible name. A ReactNode rather than a
   * string because a headline sometimes carries a badge alongside its text —
   * the action-items detail dialog is title plus priority chip.
   */
  title?: ReactNode;
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
/**
 * Deliberately not a `useDialogLayer` participant. It is rendered by `Modal` as that
 * modal's own confirmation step, and `Modal`'s Escape handler already branches on
 * `showConfirm` to dismiss this first. Registering it would make the Modal
 * non-topmost and that branch unreachable, so Escape would stop closing this dialog
 * at all. The Modal's single layer covers both surfaces.
 */
function ConfirmDiscardDialog({
  message,
  onDiscard,
  onKeepEditing,
  returnFocusTo,
}: {
  message: string;
  onDiscard: () => void;
  onKeepEditing: () => void;
  /**
   * Where focus goes on dismiss when whatever opened this dialog is gone by then
   * — most often an open Select option, which unmounts while this is up. Without
   * it focus lands on `<body>`, outside the still-open modal's trap.
   */
  returnFocusTo?: HTMLElement | null;
}) {
  const titleId = useId();
  const messageId = useId();
  const { surfaceRef, onKeyDown } = useFocusTrap(true, returnFocusTo);

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

interface DialogSurfaceBaseProps {
  isOpen: boolean;
  /** The dialog's content, chrome included. Rendered inside the surface. */
  children: ReactNode;
  /**
   * `alertdialog` for a surface that interrupts the user for a consequential
   * decision, which is the distinction APG draws between the two.
   */
  role?: "dialog" | "alertdialog";
  /** Id of the heading that names this dialog. Preferred over `label`. */
  labelledBy?: string;
  /** Accessible name when there is no heading to point at. Ignored if `labelledBy` is set. */
  label?: string;
  /** Id of the element describing it, for an alertdialog's message. */
  describedBy?: string;
  /** When true, every dismissal path routes through a discard confirmation. */
  hasUnsavedChanges?: boolean;
  confirmMessage?: string;
  /** Layer, alignment and padding. The z-index of the whole dialog lives here. */
  wrapperClassName?: string;
  /** Scrim tint. */
  scrimClassName?: string;
  /** The surface itself: width, background, radius, and how it scrolls. */
  className?: string;
  /**
   * Rendered as a DOM *sibling* of the surface, for a nested dialog of the
   * caller's own — onboarding's exit guard is the live one. Sibling rather than
   * child is load-bearing: see the note on the trap above. A nested dialog
   * rendered inside `children` would have its keydowns bubble through this
   * surface's handler and the two traps would fight.
   */
  overlay?: ReactNode;
  /** Test hook on the surface, for a caller whose tests already query one. */
  testId?: string;
}

/**
 * `dismissible` governs the *ambient* dismissal gestures — scrim click and Escape.
 * It is false for a flow that owns its own exits: guided onboarding, where landing
 * on the scrim must not throw away the run.
 *
 * The union is what keeps `onClose` honest. A dismissible dialog that forgot it
 * would be unclosable, and a non-dismissible one has nothing to call it, so
 * requiring a stub there would only invite `() => {}` at every such site.
 */
type DialogSurfaceProps = DialogSurfaceBaseProps &
  (
    | { dismissible?: true; onClose: () => void }
    | { dismissible: false; onClose?: () => void }
  );

/**
 * Everything that makes an overlay a dialog, with none of the chrome.
 *
 * Owns the focus trap, the dismissal-layer registration (topmost-only Escape plus
 * the shared body scroll lock), `role`/`aria-modal`/the accessible name, the
 * unsaved-changes guard, and the `ModalContext` that portalling children read.
 *
 * That last one is why a dialog cannot just add `useFocusTrap` locally and call it
 * done. `useModalPortalContainer()` returns null outside this provider, so every
 * Select, DatePicker and TimePicker inside falls back to `document.body` — outside
 * the surface, and therefore outside the trap that was just added. The menu still
 * looks right and is no longer reachable by keyboard. Adding the trap without the
 * provider makes a dialog worse, not better.
 *
 * (Written without angle brackets on purpose: `select-aria-label.test.ts` scans raw
 * source for call sites and does not skip comments, so a prose `<Select` reads as an
 * unlabelled one.)
 */
export function DialogSurface({
  isOpen,
  onClose,
  children,
  role = "dialog",
  labelledBy,
  label,
  describedBy,
  dismissible = true,
  hasUnsavedChanges = false,
  confirmMessage = "You have unsaved changes that will be lost.",
  wrapperClassName = "fixed inset-0 z-50 flex items-center justify-center p-4",
  scrimClassName = "absolute inset-0 bg-black/32",
  className = "relative w-full bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-hidden flex flex-col",
  overlay,
  testId,
}: DialogSurfaceProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const { surfaceRef, surface, onKeyDown } = useFocusTrap(isOpen);
  const isTopLayer = useDialogLayer(isOpen);

  const attemptClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowConfirm(true);
    } else {
      onClose?.();
    }
  }, [hasUnsavedChanges, onClose]);

  const confirmDiscard = useCallback(() => {
    setShowConfirm(false);
    onClose?.();
  }, [onClose]);

  const contextValue = useMemo(
    () => ({ portalContainer: surface, dismiss: attemptClose }),
    [surface, attemptClose],
  );

  // The scroll lock lives in useDialogLayer above, not here: it belongs to the stack
  // as a whole, and releasing it per-modal unlocked the page under anything still open.
  useEffect(() => {
    if (!isOpen || !dismissible) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Read now, not when this listener was attached — another layer may have opened
      // above this one since, and it owns the key until it closes.
      if (!isTopLayer()) return;
      if (showConfirm) {
        setShowConfirm(false);
      } else {
        attemptClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, dismissible, attemptClose, showConfirm, isTopLayer]);

  // Reset confirm dialog when the modal closes. Adjusting state during render
  // (tracking the previous isOpen) is React's pattern for prop-driven resets.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) setShowConfirm(false);
  }

  if (!isOpen) return null;

  return (
    <div className={wrapperClassName}>
      {/* Scrim. Inert rather than absent when not dismissible, so the surface is
          still visually lifted off the page behind it. */}
      <div className={scrimClassName} onClick={dismissible ? attemptClose : undefined} />

      <div
        ref={surfaceRef}
        onKeyDown={onKeyDown}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        data-testid={testId}
        className={`${className} focus:outline-none`}
      >
        {/* The provider wraps only the content: the dialogs below are DOM siblings
            with their own traps, so a menu portalled to this surface from inside one
            would land in the wrong one. */}
        <ModalContext.Provider value={contextValue}>{children}</ModalContext.Provider>
      </div>

      {overlay}

      {showConfirm && (
        <ConfirmDiscardDialog
          message={confirmMessage}
          onDiscard={confirmDiscard}
          onKeepEditing={() => setShowConfirm(false)}
          returnFocusTo={surface}
        />
      )}
    </div>
  );
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
  ariaLabel,
  hasUnsavedChanges = false,
  confirmMessage,
}: ModalProps) {
  const titleId = useId();

  const sizeClasses: Record<string, string> = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  return (
    <DialogSurface
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={title ? titleId : undefined}
      label={ariaLabel}
      hasUnsavedChanges={hasUnsavedChanges}
      confirmMessage={confirmMessage}
      className={`relative w-full ${sizeClasses[size]} bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-hidden flex flex-col`}
    >
      {/* Headline */}
      {title && <ModalHeadline id={titleId}>{title}</ModalHeadline>}

      {/* Body — headline supplies top spacing when present. */}
      <div className={`flex-1 overflow-y-auto px-6 pb-6 ${title ? "" : "pt-6"}`}>{children}</div>
    </DialogSurface>
  );
}

/**
 * A footer Cancel that routes through the enclosing dialog's unsaved-changes guard.
 *
 * Wiring Cancel straight to the caller's own `onClose` skips the confirmation that
 * the scrim, Escape and the X all honour, so a dialog with `hasUnsavedChanges`
 * warns on three dismissal paths and discards silently on the fourth. Shared
 * because it has to live *inside* the dialog to read the context, and eight call
 * sites were otherwise going to grow eight identical four-line copies of it.
 */
export function ModalCancelButton({
  children = "Cancel",
  disabled,
  variant = "text",
  size,
}: {
  children?: ReactNode;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}) {
  const dismiss = useModalDismiss();
  return (
    <Button type="button" variant={variant} size={size} onClick={dismiss} disabled={disabled}>
      {children}
    </Button>
  );
}

/**
 * The header X, for a dialog supplying its own chrome. Same reason as
 * `ModalCancelButton`: it routes through the unsaved-changes guard, and it has to
 * live inside the surface to read the context.
 *
 * It also carries the accessible name that an icon-only button needs. All three
 * hand-rolled full-screen dialogs shipped this button with no name at all, so a
 * screen reader announced their only close affordance as "button" (CAR-197).
 */
export function ModalCloseButton({
  className,
  iconClassName = "h-6 w-6",
}: {
  className?: string;
  iconClassName?: string;
}) {
  const dismiss = useModalDismiss();
  return (
    <button type="button" onClick={dismiss} aria-label="Close" className={className}>
      <X className={iconClassName} />
    </button>
  );
}

/**
 * The headline row. Split out only because its close button needs `useModalDismiss`,
 * which has to be read from *inside* the provider — `Modal` itself renders above it.
 */
function ModalHeadline({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-6 pt-6 pb-4">
      <h2 id={id} className="text-[22px] leading-7 font-normal text-foreground">{children}</h2>
      <ModalCloseButton
        className="state-layer p-2 -mr-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
        iconClassName="h-5 w-5"
      />
    </div>
  );
}
