"use client";

import { useMemo, useState, useRef } from "react";

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
  if (max === 0) return COLORS[0];
  const ratio = count / max;
  if (ratio <= 0.25) return COLORS[1];
  if (ratio <= 0.5) return COLORS[2];
  if (ratio <= 0.75) return COLORS[3];
  return COLORS[4];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    date: string;
    count: number;
    conversations: number;
    actions: number;
    contacts: number;
    left: number;
    top: number;
  } | null>(null);

  const { weeks, maxCount, monthLabels } = useMemo(() => {
    if (data.length === 0) return { weeks: [], maxCount: 1, monthLabels: [] };

    const max = Math.max(...data.map((d) => d.count), 1);

    const wks: HeatmapDay[][] = [];
    let currentWeek: HeatmapDay[] = [];

    for (let i = 0; i < data.length; i++) {
      currentWeek.push(data[i]);
      if (data[i].dayOfWeek === 6 || i === data.length - 1) {
        wks.push(currentWeek);
        currentWeek = [];
      }
    }

    const labels: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;

    for (let wi = 0; wi < wks.length; wi++) {
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

  const handleMouseEnter = (day: HeatmapDay, e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const cellRect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      date: day.date,
      count: day.count,
      conversations: day.conversations || 0,
      actions: day.actions || 0,
      contacts: day.contacts || 0,
      left: cellRect.left - containerRect.left + cellRect.width / 2,
      top: cellRect.top - containerRect.top,
    });
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* Month labels */}
      <div className="flex ml-[2rem] h-[1rem] relative">
        {monthLabels.map((ml) => (
          <span
            key={`${ml.label}-${ml.weekIndex}`}
            className="absolute text-[0.6rem] text-muted-foreground"
            style={{ left: `calc(${ml.weekIndex} * 1rem)` }}
          >
            {ml.label}
          </span>
        ))}
      </div>

      <div className="flex">
        {/* Day labels */}
        <div className="flex flex-col shrink-0 w-[2rem]">
          {["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) => (
            <div
              key={i}
              className="text-[0.6rem] text-muted-foreground leading-none flex items-center"
              style={{ height: "0.8125rem", marginBottom: i < 6 ? "0.1875rem" : 0 }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="flex" style={{ gap: "0.1875rem" }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col" style={{ gap: "0.1875rem" }}>
              {wi === 0 &&
                Array.from({ length: week[0]?.dayOfWeek || 0 }).map((_, i) => (
                  <div key={`pad-${i}`} style={{ width: "0.8125rem", height: "0.8125rem" }} />
                ))}
              {week.map((day) => (
                <div
                  key={day.date}
                  className="rounded-[2px] cursor-default"
                  style={{
                    width: "0.8125rem",
                    height: "0.8125rem",
                    backgroundColor: getColor(day.count, maxCount),
                  }}
                  onMouseEnter={(e) => handleMouseEnter(day, e)}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
              {wi === weeks.length - 1 &&
                week[week.length - 1] &&
                Array.from({ length: 6 - week[week.length - 1].dayOfWeek }).map((_, i) => (
                  <div key={`pad-end-${i}`} style={{ width: "0.8125rem", height: "0.8125rem" }} />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-1.5 ml-[2rem]">
        <span className="text-[0.6rem] text-muted-foreground">Less</span>
        {COLORS.map((color, i) => (
          <div
            key={i}
            className="rounded-[2px]"
            style={{ width: "0.625rem", height: "0.625rem", backgroundColor: color }}
          />
        ))}
        <span className="text-[0.6rem] text-muted-foreground">More</span>
      </div>

      {/* Tooltip — positioned absolute relative to container */}
      {tooltip && (
        <div
          className="absolute z-50 px-3 py-2 rounded-lg bg-foreground text-background text-xs pointer-events-none -translate-x-1/2"
          style={{
            left: tooltip.left,
            top: tooltip.top - 8,
            transform: "translate(-50%, -100%)",
          }}
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
              {tooltip.conversations > 0 && (
                <p>{tooltip.conversations} conversation{tooltip.conversations !== 1 ? "s" : ""} held</p>
              )}
              {tooltip.actions > 0 && (
                <p>{tooltip.actions} action{tooltip.actions !== 1 ? "s" : ""} taken</p>
              )}
              {tooltip.contacts > 0 && (
                <p>{tooltip.contacts} contact{tooltip.contacts !== 1 ? "s" : ""} added</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
