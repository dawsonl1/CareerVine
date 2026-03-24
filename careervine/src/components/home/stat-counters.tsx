"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface StatCard {
  label: string;
  value: number;
  previousValue: number;
}

interface StatCountersProps {
  stats: StatCard[];
}

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous;
  if (diff > 0) return <TrendingUp className="h-5 w-5 text-green-600" />;
  if (diff < 0) return <TrendingDown className="h-5 w-5 text-red-500" />;
  return <Minus className="h-5 w-5 text-muted-foreground" />;
}

export function StatCounters({ stats }: StatCountersProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {stats.map((stat) => {
        const diff = stat.value - stat.previousValue;
        return (
          <div
            key={stat.label}
            className="rounded-xl bg-surface-container-low px-6 py-5"
          >
            <div className="flex items-center gap-2">
              <span className="text-4xl font-semibold text-foreground tabular-nums">
                {stat.value}
              </span>
              <TrendArrow current={stat.value} previous={stat.previousValue} />
            </div>
            <p className="text-base text-muted-foreground mt-1">{stat.label}</p>
            {diff !== 0 && (
              <p className={`text-sm mt-0.5 ${diff > 0 ? "text-green-600" : "text-red-500"}`}>
                {diff > 0 ? "+" : ""}
                {diff} vs last week
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
