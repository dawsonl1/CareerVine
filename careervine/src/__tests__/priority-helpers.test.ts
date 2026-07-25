import { describe, it, expect } from "vitest";
import {
  getPriorityOrder,
  sortByPriorityThenDate,
  PRIORITY_COLORS,
  PRIORITY_OPTIONS,
} from "@/lib/priority-helpers";

describe("getPriorityOrder", () => {
  it("orders the three known priorities high → medium → low", () => {
    expect(getPriorityOrder("high")).toBe(0);
    expect(getPriorityOrder("medium")).toBe(1);
    expect(getPriorityOrder("low")).toBe(2);
  });

  it("sorts null, empty string, and unknown values last", () => {
    expect(getPriorityOrder(null)).toBe(3);
    expect(getPriorityOrder("")).toBe(3);
    expect(getPriorityOrder("urgent")).toBe(3);
  });

  it("does not resolve inherited Object.prototype keys as priorities", () => {
    // PRIORITY_ORDER is a plain object literal, so a lookup of "constructor"
    // or "toString" would hit the prototype chain and return a function if the
    // `??` guard were a truthiness check instead of a nullish one.
    expect(getPriorityOrder("constructor")).toBe(3);
    expect(getPriorityOrder("toString")).toBe(3);
  });
});

describe("sortByPriorityThenDate", () => {
  const sorted = <T extends { priority?: string | null; due_at?: string | null }>(items: T[]) =>
    [...items].sort(sortByPriorityThenDate);

  it("sorts by priority before due date", () => {
    const items = [
      { id: "low-soon", priority: "low", due_at: "2026-01-01" },
      { id: "high-later", priority: "high", due_at: "2026-12-31" },
      { id: "medium-mid", priority: "medium", due_at: "2026-06-01" },
    ];
    expect(sorted(items).map((i) => i.id)).toEqual(["high-later", "medium-mid", "low-soon"]);
  });

  it("breaks ties within a priority by due date ascending", () => {
    const items = [
      { id: "later", priority: "high", due_at: "2026-03-01" },
      { id: "sooner", priority: "high", due_at: "2026-01-15" },
    ];
    expect(sorted(items).map((i) => i.id)).toEqual(["sooner", "later"]);
  });

  it("puts items with no due date after dated ones of the same priority", () => {
    const items = [
      { id: "undated", priority: "high", due_at: null },
      { id: "dated", priority: "high", due_at: "2026-05-05" },
    ];
    expect(sorted(items).map((i) => i.id)).toEqual(["dated", "undated"]);
  });

  it("treats two undated items of the same priority as equal", () => {
    expect(
      sortByPriorityThenDate({ priority: "low", due_at: null }, { priority: "low", due_at: null })
    ).toBe(0);
  });

  it("sorts items with no priority last regardless of an early due date", () => {
    const items = [
      { id: "none", priority: null, due_at: "2020-01-01" },
      { id: "low", priority: "low", due_at: "2030-01-01" },
    ];
    expect(sorted(items).map((i) => i.id)).toEqual(["low", "none"]);
  });

  it("accepts records that omit the optional fields entirely", () => {
    const items = [{ id: "bare" }, { id: "high", priority: "high" }];
    expect(sorted(items).map((i) => i.id)).toEqual(["high", "bare"]);
  });
});

describe("priority presentation constants", () => {
  it("exposes styling for every priority the order function ranks", () => {
    for (const priority of ["high", "medium", "low"] as const) {
      expect(PRIORITY_COLORS[priority].label).toBeTruthy();
      expect(PRIORITY_COLORS[priority].dot).toBeTruthy();
    }
  });

  it("offers a no-priority choice plus one option per known priority", () => {
    expect(PRIORITY_OPTIONS.map((o) => o.value)).toEqual(["", "high", "medium", "low"]);
  });
});
