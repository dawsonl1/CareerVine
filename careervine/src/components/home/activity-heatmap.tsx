"use client";

import { useMemo, useState } from "react";

interface HeatmapDay {
  date: string;
  count: number;
  dayOfWeek: number;
  conversations?: number;
  actions?: number;
  contacts?: number;
}

interface ActivityHeatmapProps {
  data: HeatmapDay[];
}

const COLORS = [
  "#ebedf0", // 0 activity
  "#d4e8d0", // light
  "#94d58f", // medium
  "#4caf50", // medium-heavy
  "#2d6a30", // heavy
];

function getColor(count: number, max: number): string {
  if (count === 0) return COLORS[0];
  // Use a hybrid approach: scale relative to max, but enforce a minimum
  // max so that low-activity periods don't immediately show as darkest.
  // A single day with 1-2 items should look light, not saturated.
  const effectiveMax = Math.max(max, 8);
  const ratio = count / effectiveMax;
  if (ratio <= 0.25) return COLORS[1];
  if (ratio <= 0.5) return COLORS[2];
  if (ratio <= 0.75) return COLORS[3];
  return COLORS[4];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ date: string; count: number; conversations: number; actions: number; contacts: number; x: number; y: number } | null>(null);

  const { weeks, maxCount, monthLabels } = useMemo(() => {
    if (data.length === 0) return { weeks: [], maxCount: 1, monthLabels: [] };

    const max = Math.max(...data.map((d) => d.count), 1);

    // Group into weeks (each week is a column, Sun=0 at top)
    const wks: HeatmapDay[][] = [];
    let currentWeek: HeatmapDay[] = [];

    for (let i = 0; i < data.length; i++) {
      currentWeek.push(data[i]);
      if (data[i].dayOfWeek === 6 || i === data.length - 1) {
        wks.push(currentWeek);
        currentWeek = [];
      }
    }

    // Build month labels — positioned at the first week that starts a new month
    const labels: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;

    for (let wi = 0; wi < wks.length; wi++) {
      // Use the first day of the week to determine the month
      const firstDay = wks[wi][0];
      if (!firstDay) continue;
      const month = new Date(firstDay.date + "T12:00:00").getMonth();
      if (month !== lastMonth) {
        labels.push({ label: MONTH_NAMES[month], weekIndex: wi });
        lastMonth = month;
      }
    }

    return { weeks: wks, maxCount: max, monthLabels: labels };
  }, [data]);

  if (data.length === 0) return null;

  const cellSize = 17;
  const gap = 4;
  const step = cellSize + gap;
  const dayLabelWidth = 40;
  const monthLabelHeight = 22;

  return (
    <div className="relative">
      {/* Month labels row */}
      <div className="flex" style={{ paddingLeft: dayLabelWidth, height: monthLabelHeight }}>
        <div className="relative w-full">
          {monthLabels.map((ml) => (
            <span
              key={`${ml.label}-${ml.weekIndex}`}
              className="absolute text-sm text-muted-foreground"
              style={{ left: ml.weekIndex * step }}
            >
              {ml.label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex">
        {/* Day labels */}
        <div
          className="flex flex-col shrink-0"
          style={{ width: dayLabelWidth, height: 7 * step - gap }}
        >
          {["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) => (
            <span
              key={i}
              className="text-sm text-muted-foreground leading-none"
              style={{ height: cellSize, marginBottom: i < 6 ? gap : 0, display: "flex", alignItems: "center" }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div className="flex overflow-x-auto" style={{ gap }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col" style={{ gap }}>
              {/* Pad first week if it doesn't start on Sunday */}
              {wi === 0 &&
                Array.from({ length: week[0]?.dayOfWeek || 0 }).map((_, i) => (
                  <div key={`pad-${i}`} style={{ width: cellSize, height: cellSize }} />
                ))}
              {week.map((day) => (
                <div
                  key={day.date}
                  className="rounded-[2px] cursor-default"
                  style={{
                    width: cellSize,
                    height: cellSize,
                    backgroundColor: getColor(day.count, maxCount),
                  }}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ date: day.date, count: day.count, conversations: day.conversations || 0, actions: day.actions || 0, contacts: day.contacts || 0, x: rect.left + rect.width / 2, y: rect.top });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
              {/* Pad last week if it doesn't end on Saturday */}
              {wi === weeks.length - 1 &&
                week[week.length - 1] &&
                Array.from({ length: 6 - week[week.length - 1].dayOfWeek }).map((_, i) => (
                  <div key={`pad-end-${i}`} style={{ width: cellSize, height: cellSize }} />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-sm text-muted-foreground">Less</span>
        {COLORS.map((color, i) => (
          <div
            key={i}
            className="rounded-[3px]"
            style={{ width: 14, height: 14, backgroundColor: color }}
          />
        ))}
        <span className="text-sm text-muted-foreground">More</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 rounded-lg bg-foreground text-background text-xs pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: "translate(-50%, -100%)" }}
        >
          <p className="font-medium mb-0.5">
            {new Date(tooltip.date + "T12:00:00").toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          {tooltip.count === 0 ? (
            <p className="text-background/70">No activity</p>
          ) : (
            <div className="space-y-0.5 text-background/90">
              {tooltip.conversations > 0 && <p>{tooltip.conversations} conversation{tooltip.conversations !== 1 ? "s" : ""} held</p>}
              {tooltip.actions > 0 && <p>{tooltip.actions} action{tooltip.actions !== 1 ? "s" : ""} taken</p>}
              {tooltip.contacts > 0 && <p>{tooltip.contacts} contact{tooltip.contacts !== 1 ? "s" : ""} added</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
