"use client";

import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface StatCard {
  label: string;
  value: number;
  previousValue: number;
  /** If true, display value as percentage with % suffix */
  isPercentage?: boolean;
  /** Tooltip lines shown on hover */
  tooltipLines?: string[];
}

interface StatCountersProps {
  stats: StatCard[];
}

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous;
  if (diff > 0) return <TrendingUp className="h-6 w-6 text-green-600" />;
  if (diff < 0) return <TrendingDown className="h-6 w-6 text-red-500" />;
  return <Minus className="h-6 w-6 text-muted-foreground" />;
}

function CursorTooltip({ lines, x, y }: { lines: string[]; x: number; y: number }) {
  return createPortal(
    <div
      className="fixed z-[9999] px-4 py-3 rounded-xl bg-surface-container-highest border border-outline-variant shadow-lg min-w-[220px] pointer-events-none"
      style={{ left: x + 14, top: y + 14 }}
    >
      {lines.map((line, i) => (
        <p key={i} className="text-sm text-foreground whitespace-nowrap">
          {line}
        </p>
      ))}
    </div>,
    document.body
  );
}

export function StatCounters({ stats }: StatCountersProps) {
  const [hoveredStat, setHoveredStat] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      {stats.map((stat) => {
        const diff = stat.value - stat.previousValue;
        const hasTooltip = stat.tooltipLines && stat.tooltipLines.length > 0;
        return (
          <div
            key={stat.label}
            className={`rounded-xl bg-surface-container-low px-7 py-6 relative ${hasTooltip ? "cursor-default" : ""}`}
            onMouseEnter={() => hasTooltip && setHoveredStat(stat.label)}
            onMouseLeave={() => setHoveredStat(null)}
            onMouseMove={hasTooltip ? handleMouseMove : undefined}
          >
            {hoveredStat === stat.label && stat.tooltipLines && (
              <CursorTooltip lines={stat.tooltipLines} x={mousePos.x} y={mousePos.y} />
            )}
            <div className="flex items-center gap-2.5">
              <span className="text-5xl font-semibold text-foreground tabular-nums">
                {stat.value}{stat.isPercentage ? "%" : ""}
              </span>
              <TrendArrow current={stat.value} previous={stat.previousValue} />
            </div>
            <p className="text-lg text-muted-foreground mt-1.5">{stat.label}</p>
            {diff !== 0 && (
              <p className={`text-base mt-0.5 ${diff > 0 ? "text-green-600" : "text-red-500"}`}>
                {diff > 0 ? "+" : ""}
                {diff}{stat.isPercentage ? "%" : ""} vs last week
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
