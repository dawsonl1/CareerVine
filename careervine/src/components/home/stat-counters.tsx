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
  if (diff > 0) return <TrendingUp className="h-6 w-6 text-green-600" />;
  if (diff < 0) return <TrendingDown className="h-6 w-6 text-red-500" />;
  return <Minus className="h-6 w-6 text-muted-foreground" />;
}

export function StatCounters({ stats }: StatCountersProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {stats.map((stat) => {
        const diff = stat.value - stat.previousValue;
        return (
          <div
            key={stat.label}
            className="rounded-xl bg-surface-container-low px-7 py-6"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-5xl font-semibold text-foreground tabular-nums">
                {stat.value}
              </span>
              <TrendArrow current={stat.value} previous={stat.previousValue} />
            </div>
            <p className="text-lg text-muted-foreground mt-1.5">{stat.label}</p>
            {diff !== 0 && (
              <p className={`text-base mt-0.5 ${diff > 0 ? "text-green-600" : "text-red-500"}`}>
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
