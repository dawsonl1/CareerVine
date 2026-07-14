import { describe, it, expect } from "vitest";
import { packOverlappingEvents, slotStyle } from "@/lib/calendar-layout";

function ev(id: number, start: number, end: number) {
  return { id, startMs: start, endMs: end };
}

describe("packOverlappingEvents", () => {
  it("gives full width to a single event", () => {
    const slots = packOverlappingEvents([ev(1, 0, 60)]);
    expect(slots.get(1)).toEqual({ columnIndex: 0, columnCount: 1 });
  });

  it("places two simultaneous events side by side", () => {
    const slots = packOverlappingEvents([ev(1, 0, 60), ev(2, 0, 60)]);
    expect(slots.get(1)?.columnCount).toBe(2);
    expect(slots.get(2)?.columnCount).toBe(2);
    expect(new Set([slots.get(1)?.columnIndex, slots.get(2)?.columnIndex])).toEqual(new Set([0, 1]));
  });

  it("reuses a column when events do not overlap", () => {
    const slots = packOverlappingEvents([ev(1, 0, 30), ev(2, 30, 60)]);
    expect(slots.get(1)).toEqual({ columnIndex: 0, columnCount: 1 });
    expect(slots.get(2)).toEqual({ columnIndex: 0, columnCount: 1 });
  });

  it("packs a chain of overlapping events into shared column count", () => {
    // A overlaps B, B overlaps C, A does not overlap C
    const slots = packOverlappingEvents([
      ev(1, 0, 40),
      ev(2, 20, 60),
      ev(3, 50, 90),
    ]);
    expect(slots.get(1)?.columnCount).toBe(2);
    expect(slots.get(2)?.columnCount).toBe(2);
    expect(slots.get(3)?.columnCount).toBe(2);
    expect(slots.get(1)?.columnIndex).not.toBe(slots.get(2)?.columnIndex);
  });

  it("handles nested spans (shorter inside longer)", () => {
    const slots = packOverlappingEvents([
      ev(1, 0, 120),
      ev(2, 30, 60),
    ]);
    expect(slots.get(1)?.columnCount).toBe(2);
    expect(slots.get(2)?.columnCount).toBe(2);
    expect(slots.get(1)?.columnIndex).not.toBe(slots.get(2)?.columnIndex);
  });

  it("returns empty map for empty input", () => {
    expect(packOverlappingEvents([]).size).toBe(0);
  });
});

describe("slotStyle", () => {
  it("splits two columns roughly in half", () => {
    const a = slotStyle({ columnIndex: 0, columnCount: 2 });
    const b = slotStyle({ columnIndex: 1, columnCount: 2 });
    expect(parseFloat(a.left)).toBe(0);
    expect(parseFloat(b.left)).toBeCloseTo(parseFloat(a.width), 5);
  });
});
