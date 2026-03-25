"use client";

import { StatCounters, type StatCard } from "./stat-counters";
import { ActivityHeatmap } from "./activity-heatmap";
import { NetworkDonut } from "./network-donut";
import { NeglectedContacts } from "./neglected-contacts";
import { TrendingUp, TrendingDown, Minus, Flame } from "lucide-react";

interface HeatmapDay {
  date: string;
  count: number;
  dayOfWeek: number;
  conversations?: number;
  actions?: number;
  contacts?: number;
}

interface NetworkHealthData {
  healthy: number;
  dueSoon: number;
  overdue: number;
  neverContacted: number;
  noCadence: number;
  total: number;
}

interface NeglectedContact {
  id: number;
  name: string;
  photo_url: string | null;
  days_since_touch: number | null;
  follow_up_frequency_days: number | null;
}

interface HomeStatsData {
  meetings: { current: number; previous: number };
  pendingItems: number;
  completedItems: { current: number; previous: number };
  contactsAdded: { current: number; previous: number };
  emailsSent: { current: number; previous: number };
  touchpoints: { current: number; previous: number };
}

export interface RelationshipsOnTrackData {
  percentage: number;
  onTrack: number;
  total: number;
  breakdown: {
    withCadenceOnTrack: number;
    withCadenceOverdue: number;
    noCadence: number;
    neverContactedPast7d: number;
  };
}

interface NetworkingStatsProps {
  stats: HomeStatsData | null;
  heatmapData: HeatmapDay[];
  healthSummary: NetworkHealthData | null;
  neglectedContacts: NeglectedContact[];
  relationshipsOnTrack: RelationshipsOnTrackData | null;
  streak: number;
  loading: boolean;
}

export function NetworkingStats({
  stats,
  heatmapData,
  healthSummary,
  neglectedContacts,
  relationshipsOnTrack,
  streak,
  loading,
}: NetworkingStatsProps) {
  if (loading) {
    return (
      <div>
        <h2 className="text-[28px] font-medium text-foreground mb-3">Network Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-surface-container-highest animate-pulse" />
          ))}
        </div>
        <div className="h-36 rounded-xl bg-surface-container-highest animate-pulse" />
      </div>
    );
  }

  if (!stats) return null;

  const rot = relationshipsOnTrack;
  const rotTooltip = rot ? [
    `${rot.onTrack} of ${rot.total} relationships on track`,
    `${rot.breakdown.withCadenceOnTrack} contacted on schedule`,
    `${rot.breakdown.withCadenceOverdue} past their check-in date`,
    ...(rot.breakdown.noCadence > 0 ? [`${rot.breakdown.noCadence} have no check-in schedule`] : []),
    ...(rot.breakdown.neverContactedPast7d > 0 ? [`${rot.breakdown.neverContactedPast7d} never contacted`] : []),
  ] : [];

  const p = (n: number, singular: string, plural?: string) =>
    `${n} ${n === 1 ? singular : (plural ?? singular + "s")}`;

  const trendLine = (current: number, previous: number, singular: string, plural: string): string[] => {
    if (current === 0 && previous === 0) return [];
    const diff = current - previous;
    const absDiff = Math.abs(diff);
    const noun = absDiff === 1 ? singular : plural;
    if (diff > 0) return [`↑ ${absDiff} more ${noun} than prior 7 days`];
    if (diff < 0) return [`↓ ${absDiff} fewer ${noun} than prior 7 days`];
    return ["Same as prior 7 days"];
  };

  const statCards: StatCard[] = [
    {
      label: "Meetings (7 days)",
      value: stats.meetings.current,
      previousValue: stats.meetings.previous,
      tooltipLines: [
        `${p(stats.meetings.current, "meeting")} logged`,
        ...(stats.emailsSent.current > 0 ? [`${p(stats.emailsSent.current, "email")} sent`] : []),
        ...(stats.completedItems.current > 0 ? [`${p(stats.completedItems.current, "action item")} completed`] : []),
        ...trendLine(stats.meetings.current, stats.meetings.previous, "meeting", "meetings"),
      ],
    },
    {
      label: "Relationships on track",
      value: rot?.percentage ?? 0,
      previousValue: rot?.percentage ?? 0,
      isPercentage: true,
      tooltipLines: rotTooltip,
    },
    {
      label: "Contacts added",
      value: stats.contactsAdded.current,
      previousValue: stats.contactsAdded.previous,
      tooltipLines: [
        `${p(stats.contactsAdded.current, "new contact")} in the last 7 days`,
        ...trendLine(stats.contactsAdded.current, stats.contactsAdded.previous, "contact", "contacts"),
      ],
    },
  ];
  // touchpoints already includes meetings, so don't add meetings again
  const totalCurrent = stats.completedItems.current + stats.touchpoints.current;
  const totalPrevious = stats.completedItems.previous + stats.touchpoints.previous;
  const trendPct = totalPrevious > 0
    ? Math.round(((totalCurrent - totalPrevious) / totalPrevious) * 100)
    : totalCurrent > 0 ? 100 : 0;

  return (
    <div>
      <h2 className="text-[28px] font-medium text-foreground mb-3">Network Overview</h2>

      {/* Two-column layout: left (KPIs + charts) | right (Needs Attention) */}
      <div className="flex flex-col lg:flex-row gap-8 items-start">
        {/* Left column: KPIs on top, heatmap + donut below */}
        <div className="min-w-0 flex-1">
          {/* Stat counters — 3 cards */}
          <StatCounters stats={statCards} />

          {/* Heatmap + donut row */}
          <div className="mt-6 flex flex-col lg:flex-row gap-12 items-start">
            {/* Heatmap */}
            <div className="min-w-0 shrink-0">
              <ActivityHeatmap data={heatmapData} />
              {/* Trend line + streak — under heatmap */}
              <div className="mt-3 flex items-center justify-between">
              {(totalCurrent > 0 || totalPrevious > 0) && (
                <div className="flex items-center gap-2.5 text-lg text-muted-foreground">
                  {trendPct > 0 ? (
                    <TrendingUp className="h-4 w-4 text-primary" />
                  ) : trendPct < 0 ? (
                    <TrendingDown className="h-4 w-4 text-destructive" />
                  ) : (
                    <Minus className="h-4 w-4" />
                  )}
                  <span>
                    vs prior 7 days:{" "}
                    <span className={trendPct > 0 ? "text-primary" : trendPct < 0 ? "text-destructive" : ""}>
                      {trendPct > 0 ? "+" : ""}
                      {trendPct}% {trendPct > 0 ? "more" : trendPct < 0 ? "less" : ""} active
                    </span>
                  </span>
                </div>
              )}

              {/* Streak */}
              {streak > 0 && (
                <div className="flex items-center gap-1.5 text-base text-muted-foreground">
                  <Flame className="h-4 w-4 text-tertiary" />
                  <span className="font-medium tabular-nums">{streak}</span>
                  <span>day{streak !== 1 ? "s" : ""}</span>
                </div>
              )}
              </div>
            </div>

            {/* Donut */}
            {healthSummary && healthSummary.total > 0 && (
              <div className="shrink-0">
                <NetworkDonut data={healthSummary} />
              </div>
            )}
          </div>
        </div>

        {/* Right column: Needs Attention — spans full height */}
        <div className="shrink-0 w-full lg:w-auto">
          <NeglectedContacts contacts={neglectedContacts} />
        </div>
      </div>
    </div>
  );
}
