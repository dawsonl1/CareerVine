import { describe, expect, it } from "vitest";
import {
  defaultAvailabilityProfile,
  normalizeAvailabilityProfile,
} from "@/lib/availability-profile";

describe("normalizeAvailabilityProfile", () => {
  const fallback = defaultAvailabilityProfile();

  it("returns fallback for null/undefined/empty object (CAR-130 strip bug)", () => {
    expect(normalizeAvailabilityProfile(null, fallback)).toBe(fallback);
    expect(normalizeAvailabilityProfile(undefined, fallback)).toBe(fallback);
    expect(normalizeAvailabilityProfile({}, fallback)).toBe(fallback);
    expect(normalizeAvailabilityProfile({ workingDays: [] }, fallback)).toBe(fallback);
  });

  it("keeps a valid workingDays profile", () => {
    const raw = {
      workingDays: [
        { day: 0, enabled: true, startTime: "10:00", endTime: "16:00", bufferBefore: 5, bufferAfter: 5 },
      ],
    };
    const result = normalizeAvailabilityProfile(raw, fallback);
    expect(result.workingDays).toHaveLength(1);
    expect(result.workingDays[0].startTime).toBe("10:00");
  });

  it("fills missing day fields from fallback", () => {
    const raw = { workingDays: [{ day: 2, enabled: true }] };
    const result = normalizeAvailabilityProfile(raw, fallback);
    expect(result.workingDays[0].startTime).toBe(fallback.workingDays[0].startTime);
    expect(result.workingDays[0].day).toBe(2);
    expect(result.workingDays[0].enabled).toBe(true);
  });
});
