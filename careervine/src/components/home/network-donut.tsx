"use client";

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface NetworkHealthData {
  healthy: number;
  dueSoon: number;
  overdue: number;
  neverContacted: number;
  noCadence: number;
  total: number;
}

interface NetworkDonutProps {
  data: NetworkHealthData;
}

const SEGMENTS = [
  { key: "healthy" as const, color: "#4caf50", label: "Healthy" },
  { key: "dueSoon" as const, color: "#ff9800", label: "Due soon" },
  { key: "overdue" as const, color: "#e05555", label: "Overdue" },
  { key: "neverContacted" as const, color: "#9e9e9e", label: "Never contacted" },
  { key: "noCadence" as const, color: "#e0e0e0", label: "No cadence" },
];

export function NetworkDonut({ data }: NetworkDonutProps) {
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    mousePosRef.current = { x: e.clientX, y: e.clientY };
    if (tooltipRef.current) {
      tooltipRef.current.style.left = `${e.clientX + 14}px`;
      tooltipRef.current.style.top = `${e.clientY + 14}px`;
    }
  }, []);

  if (data.total === 0) return null;

  const size = 160;
  const strokeWidth = 20;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let offset = 0;
  const arcs = SEGMENTS.map((seg) => {
    const value = data[seg.key];
    const pct = data.total > 0 ? value / data.total : 0;
    const dashLength = pct * circumference;
    const dashOffset = -offset;
    offset += dashLength;
    return { ...seg, value, pct, dashLength, dashOffset };
  }).filter((a) => a.value > 0);

  const hoveredArc = hoveredSegment ? arcs.find((a) => a.key === hoveredSegment) : null;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }} onMouseMove={handleMouseMove}>
        <svg width={size} height={size} className="-rotate-90 overflow-visible">
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={hoveredSegment === arc.key ? strokeWidth + 4 : strokeWidth}
              strokeDasharray={`${arc.dashLength} ${circumference - arc.dashLength}`}
              strokeDashoffset={arc.dashOffset}
              className="transition-all duration-200 cursor-default"
              onMouseEnter={() => setHoveredSegment(arc.key)}
              onMouseLeave={() => setHoveredSegment(null)}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-2xl font-semibold text-foreground">{data.total}</span>
        </div>

        {hoveredArc && createPortal(
          <div
            ref={tooltipRef}
            className="fixed z-[9999] px-4 py-2.5 rounded-xl bg-surface-container-highest border border-outline-variant shadow-lg pointer-events-none"
            style={{ left: mousePosRef.current.x + 14, top: mousePosRef.current.y + 14 }}
          >
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: hoveredArc.color }} />
              <span className="text-sm font-medium text-foreground">{hoveredArc.label}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {hoveredArc.value} contact{hoveredArc.value !== 1 ? "s" : ""} · {Math.round(hoveredArc.pct * 100)}%
            </p>
          </div>,
          document.body
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        {arcs.map((arc) => (
          <span key={arc.key} className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ backgroundColor: arc.color }}
            />
            {Math.round(arc.pct * 100)}% {arc.label}
          </span>
        ))}
      </div>
    </div>
  );
}
