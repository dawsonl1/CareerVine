import { describe, expect, it } from "vitest";
import {
  formatApplicationsOpenDisplay,
  normalizeRange,
  parseApplicationsOpenValue,
  serializeApplicationsOpenValue,
} from "@/lib/applications-open-value";

describe("applications-open-value", () => {
  it("round-trips structured values", () => {
    const cases = [
      { kind: "text" as const, text: "Rolling basis", date: "", rangeStart: "", rangeEnd: "", month: "" },
      { kind: "date" as const, text: "", date: "2026-07-15", rangeStart: "", rangeEnd: "", month: "" },
      {
        kind: "range" as const,
        text: "",
        date: "",
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-31",
        month: "",
      },
      { kind: "month" as const, text: "", date: "", rangeStart: "", rangeEnd: "", month: "2026-09" },
    ];

    for (const value of cases) {
      const raw = serializeApplicationsOpenValue(value);
      expect(parseApplicationsOpenValue(raw)).toEqual(value);
    }
  });

  it("parses legacy plain text and ISO dates", () => {
    expect(parseApplicationsOpenValue("Opens after Labor Day")).toEqual({
      kind: "text",
      text: "Opens after Labor Day",
      date: "",
      rangeStart: "",
      rangeEnd: "",
      month: "",
    });
    expect(parseApplicationsOpenValue("2026-08-01").kind).toBe("date");
    expect(parseApplicationsOpenValue("2026-08").kind).toBe("month");
  });

  it("formats display strings", () => {
    expect(formatApplicationsOpenDisplay("text:Rolling basis")).toBe("Rolling basis");
    expect(formatApplicationsOpenDisplay("date:2026-07-15")).toContain("Jul");
    expect(formatApplicationsOpenDisplay("month:2026-09")).toBe("September 2026");
    expect(formatApplicationsOpenDisplay("range:2026-07-01/2026-07-31")).toContain("–");
  });

  it("normalizes reversed ranges", () => {
    const flipped = normalizeRange({
      kind: "range",
      text: "",
      date: "",
      rangeStart: "2026-08-01",
      rangeEnd: "2026-07-01",
      month: "",
    });
    expect(flipped.rangeStart).toBe("2026-07-01");
    expect(flipped.rangeEnd).toBe("2026-08-01");
  });
});
