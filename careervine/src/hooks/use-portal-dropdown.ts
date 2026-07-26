"use client";

import { useState, useRef, useEffect, useCallback, type RefObject } from "react";
import { useModalPortalContainer } from "@/components/ui/modal";

interface PortalDropdownOptions {
  /** Approximate height of the dropdown for flip-direction calculation */
  dropdownHeight: number;
  /** Approximate width for right-edge clamping */
  dropdownWidth: number;
}

/**
 * Shared hook for portal-based dropdowns (date picker, time picker, etc.).
 * Handles positioning relative to a trigger button, click-outside detection
 * across both the container ref and the portaled dropdown ref, and Escape
 * dismissal (see the effect below for why Escape is capture-phase and what
 * "this dropdown owns the key" means here).
 *
 * Callers must portal into the returned `portalContainer`, falling back to
 * `document.body` (CAR-198). Portalling to the body unconditionally puts the
 * dropdown outside the focus trap of any enclosing Modal, which leaves it
 * keyboard-unreachable while looking perfectly correct on screen. That was
 * anticipatory when CAR-198 wrote it and is load-bearing now: CAR-197 migrated
 * every dialog in the app onto modal.tsx, so ten DatePicker/TimePicker instances
 * across six files (compose, the conversation modal and its action-items section,
 * calendar, action-items, contact-actions-tab) render inside a DialogSurface and
 * get a real container back. Deleting the fallback would make each of them
 * keyboard-unreachable inside its dialog, and nothing tests those call sites.
 */
export function usePortalDropdown(
  containerRef: RefObject<HTMLElement | null>,
  { dropdownHeight, dropdownWidth }: PortalDropdownOptions
) {
  const [open, setOpen] = useState(false);
  const portalContainer = useModalPortalContainer();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  // Close on click outside — check both the container and the portaled dropdown
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, containerRef]);

  // Escape closes the dropdown, not the dialog around it (CAR-205).
  //
  // These dropdowns had no keydown handling at all. That was invisible until
  // CAR-197 gave six dialogs Escape for the first time: `modal.tsx`'s handler is
  // a document listener, so with a picker open over a dialog one press closed
  // the dialog under the user and left the picker behind.
  //
  // Capture phase, exactly as `select.tsx` does it. A document capture listener
  // runs before a document bubble listener whatever order the two components
  // mounted in, so `stopPropagation` here beats the modal deterministically
  // rather than by luck.
  //
  // The ownership check is NOT select.tsx's `activeElement === trigger`. That
  // works there because a Select's trigger is its only focusable part; these
  // dropdowns are full of real buttons (day cells, hour cells, month chevrons),
  // so the same test would decline Escape whenever focus sat on one — the bug
  // again, just narrower. "Focus is inside the widget" is the generalisation,
  // and it is measured against the same two nodes the click-outside handler
  // above already treats as inside.
  //
  // `<body>` counts as inside: clicking the panel's own padding blurs to it, and
  // a dialog opening above would have pulled focus into itself (its trap focuses
  // on open), so "focus is nowhere" cannot mean a newer layer owns the key. That
  // preserves the property select.tsx's focus check exists for — a dropdown left
  // open under a newer layer must not swallow that layer's Escape.
  useEffect(() => {
    if (!open) return;
    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      const inside =
        !active ||
        active === document.body ||
        containerRef.current?.contains(active) ||
        dropdownRef.current?.contains(active);
      if (!inside) return;
      e.stopPropagation();
      setOpen(false);
      // Hand focus back to the trigger. The dropdown's own buttons are about to
      // unmount, and focus left on `<body>` disarms the enclosing dialog's trap,
      // which is a keydown handler *on* the surface.
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleEscapeCapture, true);
    return () => document.removeEventListener("keydown", handleEscapeCapture, true);
  }, [open, containerRef]);

  // Position the dropdown relative to the trigger button, updating on scroll/resize
  useEffect(() => {
    if (!open || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow >= dropdownHeight ? rect.bottom + 8 : rect.top - dropdownHeight - 8;
      setDropdownPos({
        top: Math.max(8, top),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 16)),
      });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, { capture: true, passive: true });
    window.addEventListener("resize", updatePosition, { passive: true });
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, dropdownHeight, dropdownWidth]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return { open, setOpen, toggle, triggerRef, dropdownRef, dropdownPos, portalContainer };
}
