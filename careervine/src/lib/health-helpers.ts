/**
 * Network Health color classification — cadence-aware.
 *
 * When a contact has a follow-up cadence, colors reflect how far through
 * their cycle they are (ratio-based). Contacts with no cadence get "gray"
 * to nudge the user to configure one.
 */

export type HealthColor = "green" | "yellow" | "orange" | "red" | "gray";

export function getHealthColor(
  daysSince: number | null,
  frequencyDays: number | null,
): HealthColor {
  // No cadence configured — neutral
  if (frequencyDays === null) return "gray";

  // Never contacted but has a cadence — overdue
  if (daysSince === null) return "red";

  const ratio = daysSince / frequencyDays;
  if (ratio <= 0.5) return "green";
  if (ratio <= 0.85) return "yellow";
  if (ratio <= 1.0) return "orange";
  return "red";
}

export const healthBgColors: Record<HealthColor, string> = {
  green: "bg-[#c8e6c9]",
  yellow: "bg-[#fff9c4]",
  orange: "bg-[#ffe0b2]",
  red: "bg-[#ffcdd2]",
  gray: "bg-[#e0e0e0]",
};

export const healthStyles: Record<HealthColor, string> = {
  green: "bg-[#c8e6c9] text-[#1b5e20] ring-[#66bb6a]/30",
  yellow: "bg-[#fff9c4] text-[#f57f17] ring-[#ffee58]/30",
  orange: "bg-[#ffe0b2] text-[#e65100] ring-[#ffa726]/30",
  red: "bg-[#ffcdd2] text-[#b71c1c] ring-[#ef5350]/30",
  gray: "bg-[#e0e0e0] text-[#616161] ring-[#9e9e9e]/30",
};

export const healthRingColors: Record<HealthColor, string> = {
  green: "ring-[#66bb6a]",
  yellow: "ring-[#ffee58]",
  orange: "ring-[#ffa726]",
  red: "ring-[#ef5350]",
  gray: "ring-[#9e9e9e]",
};

export const CRITICAL_OVERDUE_DAYS = 7;

export const healthLabels: Record<HealthColor, string> = {
  green: "On track",
  yellow: "Due soon",
  orange: "Due now",
  red: "Overdue",
  gray: "No cadence set",
};
