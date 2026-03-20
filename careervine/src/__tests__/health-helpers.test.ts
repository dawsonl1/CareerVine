import { describe, it, expect } from "vitest";
import { getHealthColor } from "@/lib/health-helpers";

describe("getHealthColor", () => {
  describe("contacts with no cadence set", () => {
    it("returns gray regardless of days since touch", () => {
      expect(getHealthColor(0, null)).toBe("gray");
      expect(getHealthColor(100, null)).toBe("gray");
      expect(getHealthColor(null, null)).toBe("gray");
    });
  });

  describe("contacts with cadence but never contacted", () => {
    it("returns red", () => {
      expect(getHealthColor(null, 30)).toBe("red");
      expect(getHealthColor(null, 7)).toBe("red");
      expect(getHealthColor(null, 180)).toBe("red");
    });
  });

  describe("ratio-based thresholds (cadence set, has been contacted)", () => {
    // Using 30-day cadence for clarity: green <=15, yellow <=25.5, orange <=30, red >30

    it("returns green when ratio <= 0.5 (less than halfway through cycle)", () => {
      expect(getHealthColor(0, 30)).toBe("green");
      expect(getHealthColor(10, 30)).toBe("green");
      expect(getHealthColor(15, 30)).toBe("green"); // exactly 0.5
    });

    it("returns yellow when 0.5 < ratio <= 0.85 (approaching due date)", () => {
      expect(getHealthColor(16, 30)).toBe("yellow");
      expect(getHealthColor(20, 30)).toBe("yellow");
      expect(getHealthColor(25, 30)).toBe("yellow"); // 25/30 = 0.833...
    });

    it("returns orange when 0.85 < ratio <= 1.0 (due now)", () => {
      expect(getHealthColor(26, 30)).toBe("orange"); // 26/30 = 0.867
      expect(getHealthColor(30, 30)).toBe("orange"); // exactly 1.0
    });

    it("returns red when ratio > 1.0 (overdue)", () => {
      expect(getHealthColor(31, 30)).toBe("red");
      expect(getHealthColor(60, 30)).toBe("red");
    });
  });

  describe("works correctly with different cadence values", () => {
    it("7-day cadence", () => {
      expect(getHealthColor(3, 7)).toBe("green"); // 0.43
      expect(getHealthColor(5, 7)).toBe("yellow"); // 0.71
      expect(getHealthColor(6, 7)).toBe("orange"); // 0.86
      expect(getHealthColor(8, 7)).toBe("red"); // 1.14
    });

    it("180-day cadence", () => {
      expect(getHealthColor(45, 180)).toBe("green"); // 0.25
      expect(getHealthColor(90, 180)).toBe("green"); // 0.50
      expect(getHealthColor(120, 180)).toBe("yellow"); // 0.67
      expect(getHealthColor(160, 180)).toBe("orange"); // 0.89
      expect(getHealthColor(200, 180)).toBe("red"); // 1.11
    });

    it("365-day cadence", () => {
      expect(getHealthColor(100, 365)).toBe("green"); // 0.27
      expect(getHealthColor(300, 365)).toBe("yellow"); // 0.82
      expect(getHealthColor(350, 365)).toBe("orange"); // 0.96
      expect(getHealthColor(400, 365)).toBe("red"); // 1.10
    });
  });

  describe("edge cases", () => {
    it("0 days since touch is always green when cadence is set", () => {
      expect(getHealthColor(0, 7)).toBe("green");
      expect(getHealthColor(0, 365)).toBe("green");
    });

    it("exactly at boundary values", () => {
      // ratio = 0.5 exactly → green (<=)
      expect(getHealthColor(50, 100)).toBe("green");
      // ratio = 0.85 exactly → yellow (<=)
      expect(getHealthColor(85, 100)).toBe("yellow");
      // ratio = 1.0 exactly → orange (<=)
      expect(getHealthColor(100, 100)).toBe("orange");
      // ratio = 1.01 → red
      expect(getHealthColor(101, 100)).toBe("red");
    });
  });
});
