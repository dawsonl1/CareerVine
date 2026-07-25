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
 * Handles positioning relative to a trigger button and click-outside detection
 * across both the container ref and the portaled dropdown ref.
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
