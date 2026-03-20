"use client";

import { useState, useRef, useEffect, useCallback, type RefObject } from "react";

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
 */
export function usePortalDropdown(
  containerRef: RefObject<HTMLElement | null>,
  { dropdownHeight, dropdownWidth }: PortalDropdownOptions
) {
  const [open, setOpen] = useState(false);
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

  // Position the dropdown relative to the trigger button
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow >= dropdownHeight ? rect.bottom + 8 : rect.top - dropdownHeight - 8;
    setDropdownPos({
      top: Math.max(8, top),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 16)),
    });
  }, [open, dropdownHeight, dropdownWidth]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return { open, setOpen, toggle, triggerRef, dropdownRef, dropdownPos };
}
