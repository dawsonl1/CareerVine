/**
 * CAR-77: the onboarding company picker maps + ranks bundle_company_stats
 * RPC rows. The list must render from bundle-level data (pre-sync) with the
 * same ordering the old contact-derived list used: alumni desc → product
 * alumni desc → contact count desc → name.
 */
import { describe, it, expect } from "vitest";
import {
  toPickerCompanies,
  sortPickerCompanies,
  type PickerCompany,
} from "@/lib/onboarding/company-picker";

const row = (over: Partial<NonNullable<Parameters<typeof toPickerCompanies>[0]>[number]> = {}) => ({
  company_id: 1,
  name: "Acme",
  logo_url: null,
  prospect_count: 10,
  alumni_count: 2,
  product_alumni_count: 1,
  ...over,
});

describe("toPickerCompanies", () => {
  it("maps RPC rows and coerces bigint-ish string counts", () => {
    const [c] = toPickerCompanies([
      row({ company_id: 5, name: "IBM", logo_url: "https://x/logo.png", prospect_count: "34", alumni_count: "21", product_alumni_count: "4" }),
    ]);
    expect(c).toEqual({
      id: 5,
      name: "IBM",
      logoUrl: "https://x/logo.png",
      contactCount: 34,
      alumniCount: 21,
      productAlumniCount: 4,
    });
  });

  it("ranks alumni desc, then product alumni, then contacts, then name", () => {
    const names = toPickerCompanies([
      row({ company_id: 1, name: "Zeta", alumni_count: 5, product_alumni_count: 0, prospect_count: 10 }),
      row({ company_id: 2, name: "Alpha", alumni_count: 5, product_alumni_count: 2, prospect_count: 10 }),
      row({ company_id: 3, name: "Beta", alumni_count: 9, product_alumni_count: 0, prospect_count: 3 }),
      row({ company_id: 4, name: "Gamma", alumni_count: 5, product_alumni_count: 0, prospect_count: 20 }),
      row({ company_id: 5, name: "Delta", alumni_count: 5, product_alumni_count: 0, prospect_count: 10 }),
    ]).map((c) => c.name);
    expect(names).toEqual(["Beta", "Alpha", "Gamma", "Delta", "Zeta"]);
  });

  it("drops companies with zero prospects (membership row without live prospects)", () => {
    const list = toPickerCompanies([
      row({ company_id: 1, prospect_count: 0, alumni_count: 0, product_alumni_count: 0 }),
      row({ company_id: 2, name: "Kept", prospect_count: 1, alumni_count: 0, product_alumni_count: 0 }),
    ]);
    expect(list.map((c) => c.name)).toEqual(["Kept"]);
  });

  it("returns an empty list for null (unsubscribed caller sees zero rows)", () => {
    expect(toPickerCompanies(null)).toEqual([]);
  });
});

describe("sortPickerCompanies", () => {
  const c = (over: Partial<PickerCompany>): PickerCompany => ({
    id: 1,
    name: "Acme",
    logoUrl: null,
    contactCount: 0,
    alumniCount: 0,
    productAlumniCount: 0,
    ...over,
  });

  const list: PickerCompany[] = [
    c({ id: 1, name: "Zeta", alumniCount: 5, productAlumniCount: 1, contactCount: 30 }),
    c({ id: 2, name: "Alpha", alumniCount: 9, productAlumniCount: 0, contactCount: 5 }),
    c({ id: 3, name: "Beta", alumniCount: 2, productAlumniCount: 4, contactCount: 12 }),
    c({ id: 4, name: "Gamma", alumniCount: 0, productAlumniCount: 0, contactCount: 50 }),
  ];

  it("does not mutate the input array", () => {
    const before = list.map((x) => x.id);
    sortPickerCompanies(list, "alphabetical");
    expect(list.map((x) => x.id)).toEqual(before);
  });

  it("sorts by most BYU alumni (headline), then product alumni, contacts, name", () => {
    expect(sortPickerCompanies(list, "alumni").map((x) => x.name)).toEqual([
      "Alpha", // 9 alumni
      "Zeta", // 5 alumni
      "Beta", // 2 alumni
      "Gamma", // 0 alumni
    ]);
  });

  it("sorts by most alumni in product roles first", () => {
    expect(sortPickerCompanies(list, "productAlumni").map((x) => x.name)).toEqual([
      "Beta", // 4 product alumni
      "Zeta", // 1
      "Alpha", // 0, but 9 alumni tiebreak beats Gamma
      "Gamma", // 0 / 0
    ]);
  });

  it("sorts by most contacts first", () => {
    expect(sortPickerCompanies(list, "contacts").map((x) => x.name)).toEqual([
      "Gamma", // 50
      "Zeta", // 30
      "Beta", // 12
      "Alpha", // 5
    ]);
  });

  it("sorts alphabetically by name", () => {
    expect(sortPickerCompanies(list, "alphabetical").map((x) => x.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Zeta",
    ]);
  });
});
