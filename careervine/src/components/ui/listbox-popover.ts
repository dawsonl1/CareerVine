/**
 * The popover + keyboard mechanics shared by `Select` and `MultiSelect` (CAR-245).
 *
 * Extracted rather than copied: the behavior here is the load-bearing part of both
 * controls, and every rule in it was written against a specific failure. Two copies
 * means the next fix has to land twice, and the second copy is the one that gets
 * missed. `select.test.tsx` is the regression proof for the extraction — it was
 * written against the inlined version and passes untouched.
 *
 * The contract, and why each piece exists (full history in `select.tsx`'s header):
 *
 * - **Focus never leaves the trigger.** Options that hold real focus have to live in
 *   the tab order, and a portal can only append, so they land after every other
 *   control in the dialog. `aria-activedescendant` names the active option instead.
 * - **Escape is claimed on a document listener in the CAPTURE phase, and only while
 *   this trigger holds focus.** Capture beats the Modal's bubble-phase listener
 *   deterministically; the focus check is what stops a list left open under a newer
 *   layer from swallowing that layer's Escape.
 * - **The list portals into the enclosing Modal's surface**, not `document.body`: a
 *   list on the body sits outside the dialog's focus trap and outside its
 *   `aria-modal` subtree, so it is keyboard-unreachable and invisible to a screen
 *   reader while looking perfectly correct on screen (CAR-198).
 * - **`openAt` focuses the trigger explicitly.** Safari does not focus a button on
 *   click, and every keyboard path here reads `document.activeElement === btnRef`.
 *
 * Positions are `fixed` and recomputed on scroll/resize, so the list tracks a
 * trigger inside a scrolling container.
 */

"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useModalPortalContainer } from "@/components/ui/modal";

interface ListboxPopoverOptions {
  /** How many rows the list renders. Zero means the list never opens. */
  optionCount: number;
  /**
   * Row an opening keypress lands on, or -1 for "nothing chosen". Single-select
   * passes the committed row; multi-select passes its first selected row.
   */
  selectedIndex: number;
  /** Called with the row index Enter/Space/click committed. */
  onCommit: (index: number) => void;
  /**
   * Whether committing closes the list. False for multi-select, where the point
   * of the control is picking several values without reopening between each.
   */
  closeOnCommit: boolean;
}

export interface ListboxPopover {
  open: boolean;
  /** Row `aria-activedescendant` points at. -1 while nothing is active. */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  pos: { top: number; left: number; width: number };
  btnRef: RefObject<HTMLButtonElement | null>;
  dropRef: RefObject<HTMLDivElement | null>;
  listboxId: string;
  optionId: (index: number) => string;
  /** Modal surface to portal into, or null for `document.body`. */
  portalContainer: HTMLElement | null;
  /** Trigger click: open onto the selected row, or close if already open. */
  toggleOpen: () => void;
  close: () => void;
  commit: (index: number) => void;
  handleKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

export function useListboxPopover({
  optionCount,
  selectedIndex,
  onCommit,
  closeOnCommit,
}: ListboxPopoverOptions): ListboxPopover {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = useCallback((index: number) => `${baseId}-option-${index}`, [baseId]);
  const portalContainer = useModalPortalContainer();

  const updatePos = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const openAt = useCallback((index: number) => {
    if (optionCount === 0) return;
    updatePos();
    setActiveIndex(Math.min(Math.max(index, 0), optionCount - 1));
    setOpen(true);
    btnRef.current?.focus();
  }, [optionCount, updatePos]);

  const commit = useCallback((index: number) => {
    if (index < 0 || index >= optionCount) return;
    onCommit(index);
    if (closeOnCommit) close();
    btnRef.current?.focus();
  }, [optionCount, onCommit, closeOnCommit, close]);

  const toggleOpen = useCallback(() => {
    if (open) close();
    else openAt(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, close, openAt, selectedIndex]);

  // Close on outside click, dismiss on Escape, reposition on scroll/resize.
  useEffect(() => {
    if (!open) return;
    updatePos();

    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only claim Escape while this trigger holds focus. Without the check a list
      // left open under a newer layer would swallow that layer's Escape.
      if (document.activeElement !== btnRef.current) return;
      e.stopPropagation();
      close();
    };

    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscapeCapture, true);
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscapeCapture, true);
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, updatePos, close]);

  // Keep the active option in view when arrow keys walk past the list's edges.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    dropRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const last = optionCount - 1;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : 0);
        else setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : last);
        else setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case "Home":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : 0);
        else commit(activeIndex);
        break;
      case "Tab":
        // Not prevented: the list closes and focus moves on, as a native select does.
        if (open) close();
        break;
    }
  };

  return {
    open,
    activeIndex,
    setActiveIndex,
    pos,
    btnRef,
    dropRef,
    listboxId,
    optionId,
    portalContainer,
    toggleOpen,
    close,
    commit,
    handleKeyDown,
  };
}
