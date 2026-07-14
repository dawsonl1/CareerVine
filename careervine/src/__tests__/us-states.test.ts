import { describe, it, expect } from "vitest";
import { US_STATE_OPTIONS, canonicalUsState, isUnitedStates } from "@/lib/us-states";

describe("canonicalUsState", () => {
  it("maps 2-letter codes (any case, tolerant of dots) to the full name", () => {
    expect(canonicalUsState("CA")).toBe("California");
    expect(canonicalUsState("ca")).toBe("California");
    expect(canonicalUsState("N.Y.")).toBe("New York");
    expect(canonicalUsState("DC")).toBe("District of Columbia");
    expect(canonicalUsState("  tx ")).toBe("Texas");
  });

  it("maps full names (any case) to the canonical full name", () => {
    expect(canonicalUsState("california")).toBe("California");
    expect(canonicalUsState("California")).toBe("California");
    expect(canonicalUsState("NEW YORK")).toBe("New York");
    expect(canonicalUsState("district of columbia")).toBe("District of Columbia");
  });

  it("returns null for anything that is not a recognized US state", () => {
    expect(canonicalUsState("Calif.")).toBeNull();
    expect(canonicalUsState("Ontario")).toBeNull();
    expect(canonicalUsState("XX")).toBeNull();
    expect(canonicalUsState("")).toBeNull();
    expect(canonicalUsState("   ")).toBeNull();
    expect(canonicalUsState(null)).toBeNull();
    expect(canonicalUsState(undefined)).toBeNull();
  });
});

describe("US_STATE_OPTIONS", () => {
  it("has 51 entries (50 states + DC), value === label, all full names", () => {
    expect(US_STATE_OPTIONS).toHaveLength(51);
    for (const o of US_STATE_OPTIONS) {
      expect(o.value).toBe(o.label);
      // Every option value is itself canonical.
      expect(canonicalUsState(o.value)).toBe(o.value);
    }
    const labels = US_STATE_OPTIONS.map((o) => o.label);
    expect(labels).toContain("District of Columbia");
    expect(labels).toContain("California");
  });

  it("is sorted alphabetically by name", () => {
    const labels = US_STATE_OPTIONS.map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sorted);
    expect(labels[0]).toBe("Alabama");
  });
});

describe("isUnitedStates", () => {
  it("treats empty/unset and US aliases as the United States", () => {
    for (const c of ["", "  ", "United States", "united states", "USA", "us", "u.s.", "  United States of America ", null, undefined]) {
      expect(isUnitedStates(c)).toBe(true);
    }
  });

  it("is false for other countries", () => {
    for (const c of ["Canada", "United Kingdom", "Germany", "Mexico"]) {
      expect(isUnitedStates(c)).toBe(false);
    }
  });
});
