/**
 * Availability profile shape used by Settings and the compose availability picker.
 * Stored on gmail_connections.availability_standard / availability_priority.
 */

export type AvailabilityDayConfig = {
  day: number;
  enabled: boolean;
  startTime: string;
  endTime: string;
  bufferBefore: number;
  bufferAfter: number;
};

export type AvailabilityProfile = {
  workingDays: AvailabilityDayConfig[];
};

export function defaultAvailabilityProfile(
  opts: { endTime?: string; bufferBefore?: number; bufferAfter?: number } = {}
): AvailabilityProfile {
  const endTime = opts.endTime ?? "18:00";
  const bufferBefore = opts.bufferBefore ?? 10;
  const bufferAfter = opts.bufferAfter ?? 10;
  return {
    workingDays: Array.from({ length: 7 }, (_, i) => ({
      day: i,
      enabled: i < 5,
      startTime: "09:00",
      endTime,
      bufferBefore,
      bufferAfter,
    })),
  };
}

/**
 * Coerce stored JSON into a usable profile. Empty `{}` (from the CAR-130 Zod
 * strip bug) and legacy shapes without workingDays fall back to defaults.
 */
export function normalizeAvailabilityProfile(
  raw: unknown,
  fallback: AvailabilityProfile
): AvailabilityProfile {
  if (!raw || typeof raw !== "object") return fallback;
  const workingDays = (raw as { workingDays?: unknown }).workingDays;
  if (!Array.isArray(workingDays) || workingDays.length === 0) return fallback;

  return {
    workingDays: workingDays.map((day, i) => {
      const d = day && typeof day === "object" ? (day as Partial<AvailabilityDayConfig>) : {};
      const base = fallback.workingDays[i] ?? fallback.workingDays[0];
      return {
        day: typeof d.day === "number" ? d.day : base.day,
        enabled: typeof d.enabled === "boolean" ? d.enabled : base.enabled,
        startTime: typeof d.startTime === "string" ? d.startTime : base.startTime,
        endTime: typeof d.endTime === "string" ? d.endTime : base.endTime,
        bufferBefore: typeof d.bufferBefore === "number" ? d.bufferBefore : base.bufferBefore,
        bufferAfter: typeof d.bufferAfter === "number" ? d.bufferAfter : base.bufferAfter,
      };
    }),
  };
}
