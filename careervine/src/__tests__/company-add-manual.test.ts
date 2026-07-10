import { describe, expect, it } from "vitest";
import { normalizeManualCompanyInput } from "@/lib/company-queries";

describe("normalizeManualCompanyInput", () => {
  it("returns null when the name is missing or blank", () => {
    expect(normalizeManualCompanyInput({})).toBeNull();
    expect(normalizeManualCompanyInput({ name: "   " })).toBeNull();
  });

  it("trims the name and normalizes an empty LinkedIn URL to null", () => {
    expect(normalizeManualCompanyInput({ name: "  Figma ", linkedin_url: "  " })).toEqual({
      name: "Figma",
      linkedin_url: null,
      location: null,
    });
  });

  it("keeps a provided LinkedIn URL", () => {
    expect(
      normalizeManualCompanyInput({ name: "Figma", linkedin_url: " https://www.linkedin.com/company/figma " }),
    ).toEqual({
      name: "Figma",
      linkedin_url: "https://www.linkedin.com/company/figma",
      location: null,
    });
  });

  it("ignores the location when only the prefilled country is present", () => {
    expect(normalizeManualCompanyInput({ name: "Figma", country: "United States" })?.location).toBeNull();
  });

  it("includes a normalized location when city or state is filled", () => {
    expect(normalizeManualCompanyInput({ name: "Figma", city: " San Francisco ", country: "" })?.location).toEqual({
      city: "San Francisco",
      state: null,
      country: "United States",
    });
    expect(normalizeManualCompanyInput({ name: "Qualtrics", state: "Utah", country: "United States" })?.location).toEqual({
      city: null,
      state: "Utah",
      country: "United States",
    });
  });
});
