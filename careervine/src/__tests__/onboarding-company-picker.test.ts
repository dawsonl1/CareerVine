import { describe, it, expect, vi, beforeEach } from "vitest";

// CAR-77: the onboarding picker's bundle-level data source — mapping of
// bundle_company_stats rows and the shared "warmest doors first" sort.

const mockRpc = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({ rpc: mockRpc }),
}));

import {
  getBundlePickerCompanies,
  comparePickerCompanies,
  type PickerCompany,
} from "@/lib/onboarding/company-picker";

function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    company_id: 1,
    name: "Acme",
    logo_url: null,
    prospect_count: 5,
    alumni_count: 0,
    product_alumni_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockRpc.mockReset();
});

describe("getBundlePickerCompanies", () => {
  it("calls bundle_company_stats with the bundle id and maps rows to PickerCompany", async () => {
    mockRpc.mockResolvedValue({
      data: [
        statsRow({
          company_id: 42,
          name: "Vercel",
          logo_url: "https://logo.example/vercel.png",
          prospect_count: 12,
          alumni_count: 3,
          product_alumni_count: 2,
        }),
      ],
      error: null,
    });

    const companies = await getBundlePickerCompanies(7);

    expect(mockRpc).toHaveBeenCalledWith("bundle_company_stats", { p_bundle_id: 7 });
    expect(companies).toEqual([
      {
        id: 42,
        name: "Vercel",
        logoUrl: "https://logo.example/vercel.png",
        contactCount: 12,
        alumniCount: 3,
        productAlumniCount: 2,
      },
    ]);
  });

  it("sorts warmest doors first: alumni, then product alumni, then size, then name", async () => {
    mockRpc.mockResolvedValue({
      data: [
        statsRow({ company_id: 1, name: "Zeta", prospect_count: 50 }),
        statsRow({ company_id: 2, name: "Alpha", prospect_count: 50 }),
        statsRow({ company_id: 3, name: "Big", prospect_count: 99 }),
        statsRow({ company_id: 4, name: "AlumCo", prospect_count: 1, alumni_count: 2 }),
        statsRow({
          company_id: 5,
          name: "ProductCo",
          prospect_count: 1,
          alumni_count: 2,
          product_alumni_count: 1,
        }),
      ],
      error: null,
    });

    const names = (await getBundlePickerCompanies(1)).map((c) => c.name);
    expect(names).toEqual(["ProductCo", "AlumCo", "Big", "Alpha", "Zeta"]);
  });

  it("coerces stringy bigint counts to numbers", async () => {
    // PostgREST serializes bigint aggregates as JSON numbers today, but the
    // mapper must survive string payloads too.
    mockRpc.mockResolvedValue({
      data: [
        statsRow({ prospect_count: "12", alumni_count: "3", product_alumni_count: "1" }),
      ],
      error: null,
    });

    const [company] = await getBundlePickerCompanies(1);
    expect(company.contactCount).toBe(12);
    expect(company.alumniCount).toBe(3);
    expect(company.productAlumniCount).toBe(1);
  });

  it("returns [] on a null RPC result (pre-subscription RLS returns no rows)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await getBundlePickerCompanies(1)).toEqual([]);
  });
});

describe("comparePickerCompanies", () => {
  const base: PickerCompany = {
    id: 0,
    name: "",
    logoUrl: null,
    contactCount: 0,
    alumniCount: 0,
    productAlumniCount: 0,
  };

  it("falls through alumni → product → count → name", () => {
    const a = { ...base, name: "A", alumniCount: 1 };
    const b = { ...base, name: "B", contactCount: 100 };
    expect(comparePickerCompanies(a, b)).toBeLessThan(0);

    const c = { ...base, name: "C", alumniCount: 1, productAlumniCount: 1 };
    expect(comparePickerCompanies(c, a)).toBeLessThan(0);

    const d = { ...base, name: "D" };
    const e = { ...base, name: "E" };
    expect(comparePickerCompanies(d, e)).toBeLessThan(0);
  });
});
