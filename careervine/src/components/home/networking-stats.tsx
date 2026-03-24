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
  conversations: { thisWeek: number; lastWeek: number };
  pendingItems: number;
  completedItems: { thisWeek: number; lastWeek: number };
  contactsAdded: { thisWeek: number; lastWeek: number };
  touchpoints: { thisWeek: number; lastWeek: number };
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
        <h2 className="text-[28px] font-medium text-foreground mb-6">Network Overview</h2>
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
    `${rot.breakdown.withCadenceOnTrack} within cadence`,
    `${rot.breakdown.withCadenceOverdue} overdue`,
    ...(rot.breakdown.noCadence > 0 ? [`${rot.breakdown.noCadence} no cadence set`] : []),
    ...(rot.breakdown.neverContactedPast7d > 0 ? [`${rot.breakdown.neverContactedPast7d} never contacted`] : []),
  ] : [];

  const statCards: StatCard[] = [
    {
      label: "Conversations this week",
      value: stats.conversations.thisWeek,
      previousValue: stats.conversations.lastWeek,
      tooltipLines: [
        `${stats.conversations.thisWeek} meetings logged this week`,
        `${stats.conversations.lastWeek} last week`,
        ...(stats.completedItems.thisWeek > 0 ? [`${stats.completedItems.thisWeek} action items completed`] : []),
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
      value: stats.contactsAdded.thisWeek,
      previousValue: stats.contactsAdded.lastWeek,
      tooltipLines: [
        `${stats.contactsAdded.thisWeek} new contacts this week`,
        `${stats.contactsAdded.lastWeek} last week`,
      ],
    },
  ];

  // Compute trend
  const totalThisWeek = stats.conversations.thisWeek + stats.completedItems.thisWeek + stats.touchpoints.thisWeek;
  const totalLastWeek = stats.conversations.lastWeek + stats.completedItems.lastWeek + stats.touchpoints.lastWeek;
  const trendPct = totalLastWeek > 0
    ? Math.round(((totalThisWeek - totalLastWeek) / totalLastWeek) * 100)
    : totalThisWeek > 0 ? 100 : 0;

  return (
    <div>
      <h2 className="text-[28px] font-medium text-foreground mb-6">Network Overview</h2>

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
              {(totalThisWeek > 0 || totalLastWeek > 0) && (
                <div className="flex items-center gap-2.5 text-lg text-muted-foreground">
                  {trendPct > 0 ? (
                    <TrendingUp className="h-4 w-4 text-green-600" />
                  ) : trendPct < 0 ? (
                    <TrendingDown className="h-4 w-4 text-red-500" />
                  ) : (
                    <Minus className="h-4 w-4" />
                  )}
                  <span>
                    This week vs last:{" "}
                    <span className={trendPct > 0 ? "text-green-600" : trendPct < 0 ? "text-red-500" : ""}>
                      {trendPct > 0 ? "+" : ""}
                      {trendPct}% {trendPct > 0 ? "more" : trendPct < 0 ? "less" : ""} active
                    </span>
                  </span>
                </div>
              )}

              {/* Streak */}
              {streak > 0 && (
                <div className="flex items-center gap-1.5 text-base text-muted-foreground">
                  <Flame className="h-4 w-4 text-orange-500" />
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
