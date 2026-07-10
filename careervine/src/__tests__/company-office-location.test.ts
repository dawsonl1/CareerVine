import { describe, expect, it } from "vitest";
import {
  formatCompanyOfficeLocationLabel,
  normalizeCompanyOfficeLocationInput,
} from "@/lib/company-queries";

describe("normalizeCompanyOfficeLocationInput", () => {
  it("trims text and normalizes empty values to null", () => {
    expect(
      normalizeCompanyOfficeLocationInput({
        city: "  Salt Lake City ",
        state: "  Utah ",
        country: "  United States ",
      }),
    ).toEqual({
      city: "Salt Lake City",
      state: "Utah",
      country: "United States",
    });
  });

  it("defaults country to United States", () => {
    expect(
      normalizeCompanyOfficeLocationInput({
        city: "London",
        state: null,
        country: "",
      }),
    ).toEqual({
      city: "London",
      state: null,
      country: "United States",
    });
  });
});

describe("formatCompanyOfficeLocationLabel", () => {
  it("prefers city + state when city exists", () => {
    expect(
      formatCompanyOfficeLocationLabel({
        city: "Austin",
        state: "Texas",
        country: "United States",
      }),
    ).toBe("Austin, Texas");
  });

  it("falls back to state + country when city is missing", () => {
    expect(
      formatCompanyOfficeLocationLabel({
        city: null,
        state: "Ontario",
        country: "Canada",
      }),
    ).toBe("Ontario, Canada");
  });
});
