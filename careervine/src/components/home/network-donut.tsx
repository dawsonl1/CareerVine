"use client";

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
  if (data.total === 0) return null;

  const size = 140;
  const strokeWidth = 18;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Build segments
  let offset = 0;
  const arcs = SEGMENTS.map((seg) => {
    const value = data[seg.key];
    const pct = data.total > 0 ? value / data.total : 0;
    const dashLength = pct * circumference;
    const dashOffset = -offset;
    offset += dashLength;
    return { ...seg, value, pct, dashLength, dashOffset };
  }).filter((a) => a.value > 0);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${arc.dashLength} ${circumference - arc.dashLength}`}
              strokeDashoffset={arc.dashOffset}
              className="transition-all duration-500"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-semibold text-foreground">{data.total}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        {arcs.map((arc) => (
          <span key={arc.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: arc.color }}
            />
            {Math.round(arc.pct * 100)}% {arc.label}
          </span>
        ))}
      </div>
    </div>
  );
}
