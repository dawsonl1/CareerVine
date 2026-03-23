"use client";

import { StatCounters, type StatCard } from "./stat-counters";
import { ActivityHeatmap } from "./activity-heatmap";
import { NetworkDonut } from "./network-donut";
import { NeglectedContacts } from "./neglected-contacts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface HeatmapDay {
  date: string;
  count: number;
  dayOfWeek: number;
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

interface NetworkingStatsProps {
  stats: HomeStatsData | null;
  heatmapData: HeatmapDay[];
  healthSummary: NetworkHealthData | null;
  neglectedContacts: NeglectedContact[];
  loading: boolean;
}

export function NetworkingStats({
  stats,
  heatmapData,
  healthSummary,
  neglectedContacts,
  loading,
}: NetworkingStatsProps) {
  if (loading) {
    return (
      <div>
        <h2 className="text-lg font-medium text-foreground mb-4">Your Networking</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-surface-container-highest animate-pulse" />
          ))}
        </div>
        <div className="h-32 rounded-xl bg-surface-container-highest animate-pulse" />
      </div>
    );
  }

  if (!stats) return null;

  const statCards: StatCard[] = [
    { label: "Conversations this week", value: stats.conversations.thisWeek, previousValue: stats.conversations.lastWeek },
    { label: "Pending items", value: stats.pendingItems, previousValue: stats.pendingItems }, // No trend for pending
    { label: "Contacts added", value: stats.contactsAdded.thisWeek, previousValue: stats.contactsAdded.lastWeek },
    { label: "Touchpoints this week", value: stats.touchpoints.thisWeek, previousValue: stats.touchpoints.lastWeek },
  ];

  // Compute trend
  const totalThisWeek = stats.conversations.thisWeek + stats.completedItems.thisWeek + stats.touchpoints.thisWeek;
  const totalLastWeek = stats.conversations.lastWeek + stats.completedItems.lastWeek + stats.touchpoints.lastWeek;
  const trendPct = totalLastWeek > 0
    ? Math.round(((totalThisWeek - totalLastWeek) / totalLastWeek) * 100)
    : totalThisWeek > 0 ? 100 : 0;

  return (
    <div>
      <h2 className="text-lg font-medium text-foreground mb-4">Your Networking</h2>

      {/* Stat counters */}
      <StatCounters stats={statCards} />

      {/* Heatmap + donut + neglected */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-6 items-start">
        {/* Heatmap */}
        <div className="min-w-0 overflow-x-auto">
          <ActivityHeatmap data={heatmapData} />
        </div>

        {/* Donut */}
        {healthSummary && healthSummary.total > 0 && (
          <NetworkDonut data={healthSummary} />
        )}

        {/* Neglected contacts */}
        <NeglectedContacts contacts={neglectedContacts} />
      </div>

      {/* Trend line */}
      {(totalThisWeek > 0 || totalLastWeek > 0) && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
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
    </div>
  );
}
