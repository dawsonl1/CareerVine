"use client";

import { useMemo, useState } from "react";

interface HeatmapDay {
  date: string;
  count: number;
  dayOfWeek: number;
}

interface ActivityHeatmapProps {
  data: HeatmapDay[];
}

const COLORS = [
  "#f0f0f0", // 0 activity
  "#d4e8d0", // light
  "#94d58f", // medium
  "#4caf50", // medium-heavy
  "#2d6a30", // heavy
];

function getColor(count: number, max: number): string {
  if (count === 0) return COLORS[0];
  if (max === 0) return COLORS[0];
  const ratio = count / max;
  if (ratio <= 0.25) return COLORS[1];
  if (ratio <= 0.5) return COLORS[2];
  if (ratio <= 0.75) return COLORS[3];
  return COLORS[4];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ date: string; count: number; x: number; y: number } | null>(null);

  const { weeks, maxCount } = useMemo(() => {
    const max = Math.max(...data.map((d) => d.count), 1);
    // Group by week (columns)
    const wks: HeatmapDay[][] = [];
    let currentWeek: HeatmapDay[] = [];

    for (let i = 0; i < data.length; i++) {
      currentWeek.push(data[i]);
      if (data[i].dayOfWeek === 6 || i === data.length - 1) {
        wks.push(currentWeek);
        currentWeek = [];
      }
    }

    return { weeks: wks, maxCount: max };
  }, [data]);

  if (data.length === 0) return null;

  const cellSize = 14;
  const gap = 3;

  return (
    <div className="relative">
      <div className="flex gap-1">
        {/* Day labels */}
        <div className="flex flex-col justify-between pr-1" style={{ height: 7 * (cellSize + gap) - gap }}>
          {DAY_LABELS.map((label, i) => (
            <span
              key={label}
              className="text-[10px] text-muted-foreground leading-none"
              style={{ height: cellSize, display: "flex", alignItems: "center" }}
            >
              {i % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {/* Pad first week if it doesn't start on Sunday */}
              {wi === 0 &&
                Array.from({ length: week[0]?.dayOfWeek || 0 }).map((_, i) => (
                  <div
                    key={`pad-${i}`}
                    style={{ width: cellSize, height: cellSize }}
                  />
                ))}
              {week.map((day) => (
                <div
                  key={day.date}
                  className="rounded-[3px] transition-colors cursor-default"
                  style={{
                    width: cellSize,
                    height: cellSize,
                    backgroundColor: getColor(day.count, maxCount),
                  }}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ date: day.date, count: day.count, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-[10px] text-muted-foreground">Less</span>
        {COLORS.map((color, i) => (
          <div
            key={i}
            className="rounded-[2px]"
            style={{ width: 10, height: 10, backgroundColor: color }}
          />
        ))}
        <span className="text-[10px] text-muted-foreground">More</span>
        <span className="text-[10px] text-muted-foreground ml-2">12 weeks</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-2 py-1 rounded-md bg-foreground text-background text-[11px] pointer-events-none whitespace-nowrap"
          style={{ left: tooltip.x, top: tooltip.y - 30 }}
        >
          {new Date(tooltip.date + "T12:00:00").toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
          : {tooltip.count} {tooltip.count === 1 ? "activity" : "activities"}
        </div>
      )}
    </div>
  );
}
