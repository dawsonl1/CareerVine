/**
 * M3 plain tooltip — a dark rounded label that appears on hover/focus.
 *
 * CSS-only (group-hover), so it adds no listeners or state. Wraps its
 * trigger in an inline-flex span; the label is absolutely positioned and
 * never intercepts pointer events. Use for icon buttons and other
 * controls whose meaning isn't obvious from the icon alone — prefer this
 * over the native `title` attribute, which is slow to appear and unstyled.
 */

import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** Which side of the trigger the label appears on. */
  side?: "top" | "bottom";
}

export function Tooltip({ label, children, side = "bottom" }: TooltipProps) {
  const position =
    side === "bottom"
      ? "top-full mt-1.5"
      : "bottom-full mb-1.5";

  return (
    <span className="relative inline-flex group/tooltip">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${position} z-50 whitespace-nowrap rounded-lg bg-inverse-surface text-inverse-on-surface text-xs font-medium px-2.5 py-1.5 opacity-0 transition-opacity duration-150 delay-100 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100`}
      >
        {label}
      </span>
    </span>
  );
}
