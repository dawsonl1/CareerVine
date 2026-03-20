export type Priority = "high" | "medium" | "low";

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const NULL_ORDER = 3;

export function getPriorityOrder(priority: string | null): number {
  if (!priority) return NULL_ORDER;
  return PRIORITY_ORDER[priority] ?? NULL_ORDER;
}

export const PRIORITY_COLORS = {
  high: { dot: "bg-red-500", badge: "bg-red-500 text-white", text: "text-red-600", label: "High" },
  medium: { dot: "bg-amber-400", badge: "bg-amber-600 text-white", text: "text-amber-600", label: "Medium" },
  low: { dot: "bg-blue-400", badge: "bg-blue-600 text-white", text: "text-blue-600", label: "Low" },
} as const;

export const PRIORITY_OPTIONS = [
  { value: "", label: "No priority" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/** Sort comparator: priority first (high→medium→low→null), then by due_at ascending. */
export function sortByPriorityThenDate<T extends { priority?: string | null; due_at?: string | null }>(
  a: T,
  b: T
): number {
  const pa = getPriorityOrder(a.priority ?? null);
  const pb = getPriorityOrder(b.priority ?? null);
  if (pa !== pb) return pa - pb;
  if (!a.due_at && !b.due_at) return 0;
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
}
