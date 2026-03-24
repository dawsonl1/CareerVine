"use client";

import { useRef, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface CursorTooltipProps {
  children: ReactNode;
  visible: boolean;
  initialX: number;
  initialY: number;
}

/**
 * A tooltip that follows the cursor. Render as a portal on document.body.
 * Parent should track mouse position and pass it as initialX/initialY.
 * Uses a ref for direct DOM updates to avoid re-renders on every mousemove.
 */
export function CursorTooltip({ children, visible, initialX, initialY }: CursorTooltipProps) {
  if (!visible) return null;
  return createPortal(
    <div
      className="fixed z-[9999] px-4 py-2.5 rounded-xl bg-surface-container-highest border border-outline-variant shadow-lg pointer-events-none"
      style={{ left: initialX + 14, top: initialY + 14 }}
    >
      {children}
    </div>,
    document.body
  );
}

/**
 * Hook to track mouse position via ref + direct DOM updates.
 * Returns: { posRef, tooltipRef, handleMouseMove }
 * Attach handleMouseMove to the container's onMouseMove.
 * Pass posRef.current to CursorTooltip's initialX/initialY.
 * Attach tooltipRef to the tooltip's container for direct DOM positioning.
 */
export function useCursorTooltip() {
  const posRef = useRef({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    posRef.current = { x: e.clientX, y: e.clientY };
    if (tooltipRef.current) {
      tooltipRef.current.style.left = `${e.clientX + 14}px`;
      tooltipRef.current.style.top = `${e.clientY + 14}px`;
    }
  }, []);

  return { posRef, tooltipRef, handleMouseMove };
}
