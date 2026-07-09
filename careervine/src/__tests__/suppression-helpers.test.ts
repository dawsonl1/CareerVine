import { describe, it, expect } from "vitest";
import { suppressionTombstoneUrl } from "@/lib/suppression-helpers";

describe("suppressionTombstoneUrl", () => {
  it("returns the canonical URL for a scrape-imported contact", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "https://www.linkedin.com/in/jane-doe",
        import_source: "apify:search_a:2026-07_tranche1",
      }),
    ).toBe("https://www.linkedin.com/in/jane-doe");
  });

  it("canonicalizes messy URLs before tombstoning", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "http://LinkedIn.com/in/Jane-Doe/?utm_source=share",
        import_source: "apify:search_b:2026-07_tranche1",
      }),
    ).toBe("https://www.linkedin.com/in/jane-doe");
  });

  it("preserves case for internal-id slugs", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "https://www.linkedin.com/in/ACoAAABeT88xyz",
        import_source: "apify:search_a:2026-07_tranche1",
      }),
    ).toBe("https://www.linkedin.com/in/ACoAAABeT88xyz");
  });

  it("returns null for extension/manual contacts (no import_source)", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "https://www.linkedin.com/in/jane-doe",
        import_source: null,
      }),
    ).toBeNull();
  });

  it("returns null for non-apify import sources", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "https://www.linkedin.com/in/jane-doe",
        import_source: "manual",
      }),
    ).toBeNull();
  });

  it("returns null when the contact has no linkedin_url", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: null,
        import_source: "apify:search_a:2026-07_tranche1",
      }),
    ).toBeNull();
  });

  it("returns null for non-profile LinkedIn URLs", () => {
    expect(
      suppressionTombstoneUrl({
        linkedin_url: "https://www.linkedin.com/company/domo",
        import_source: "apify:search_a:2026-07_tranche1",
      }),
    ).toBeNull();
  });
});
