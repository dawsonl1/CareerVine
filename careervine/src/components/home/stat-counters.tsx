"use client";

import { useState } from "react";
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

function StatTooltip({ lines }: { lines: string[] }) {
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 px-4 py-3 rounded-xl bg-surface-container-highest border border-outline-variant shadow-lg min-w-[220px] animate-in fade-in zoom-in-95 duration-150">
      {lines.map((line, i) => (
        <p key={i} className="text-sm text-foreground whitespace-nowrap">
          {line}
        </p>
      ))}
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-surface-container-highest border-r border-b border-outline-variant rotate-45 -mt-[5px]" />
    </div>
  );
}

export function StatCounters({ stats }: StatCountersProps) {
  const [hoveredStat, setHoveredStat] = useState<string | null>(null);

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
          >
            {hoveredStat === stat.label && stat.tooltipLines && (
              <StatTooltip lines={stat.tooltipLines} />
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
