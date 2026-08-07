import { describe, it, expect } from "vitest";
import {
  EMPTY_SELECTION,
  companyHref,
  locationOptions,
  matchedOffices,
  noLocationCount,
  officeGroup,
  parseLocationSelection,
  preselectedOffice,
  scopedCounts,
} from "@/lib/company-location-filter";
import type { CompanyRosterEntry, CompanySummary } from "@/lib/company-queries";

let nextId = 1;

function office(location_id: number, city: string, state: string | null, country = "United States") {
  return { location_id, city, state, country, label: state ? `${city}, ${state}` : `${city}, ${country}` };
}

function person(overrides: Partial<CompanyRosterEntry> & { contact_id: number }): CompanyRosterEntry {
  return {
    location_id: null,
    remote: false,
    is_current: true,
    bench: false,
    alum: false,
    product_alum: false,
    recruiter: false,
    ...overrides,
  };
}

function company(overrides: Partial<CompanySummary> = {}): CompanySummary {
  return {
    id: nextId++,
    name: "Acme",
    logo_url: null,
    linkedin_url: null,
    current_count: 0,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    target: null,
    office_scopes: [],
    offices: [],
    roster: [],
    traction: null,
    traction_detail: null,
    lead_detail: null,
    ...overrides,
  };
}

const sel = (...values: string[]) => parseLocationSelection(values);

describe("officeGroup", () => {
  it("groups by state when there is one", () => {
    expect(officeGroup(office(1, "Lehi", "Utah"))).toBe("Utah");
  });

  it("falls back to country for a location with no state", () => {
    // International locations frequently have no state, and a blank group
    // header is worse than the country name.
    expect(officeGroup({ state: null, country: "Belgium" })).toBe("Belgium");
  });

  it("treats a whitespace-only state as absent", () => {
    expect(officeGroup({ state: "   ", country: "Belgium" })).toBe("Belgium");
  });
});

describe("locationOptions", () => {
  it("nests cities under their state and sorts cities by label", () => {
    const rows = [
      company({ offices: [office(1, "Provo", "Utah")] }),
      company({ offices: [office(2, "Lehi", "Utah")] }),
    ];
    const [utah] = locationOptions(rows);
    expect(utah.label).toBe("Utah");
    expect(utah.cities.map((c) => c.label)).toEqual(["Lehi, Utah", "Provo, Utah"]);
  });

  it("counts a multi-office company ONCE in its state", () => {
    // A group header is a promise about how many rows clicking it yields, so it
    // has to be distinct companies rather than the sum of its city counts.
    const rows = [company({ offices: [office(1, "Lehi", "Utah"), office(2, "Provo", "Utah")] })];
    const [utah] = locationOptions(rows);
    expect(utah.count).toBe(1);
    expect(utah.cities.map((c) => c.count)).toEqual([1, 1]);
  });

  it("orders groups by company count, densest first", () => {
    const rows = [
      company({ offices: [office(1, "Lehi", "Utah")] }),
      company({ offices: [office(2, "Provo", "Utah")] }),
      company({ offices: [office(3, "Boston", "Massachusetts")] }),
    ];
    expect(locationOptions(rows).map((g) => g.label)).toEqual(["Utah", "Massachusetts"]);
  });

  it("ignores companies with no offices", () => {
    expect(locationOptions([company()])).toEqual([]);
  });
});

describe("noLocationCount", () => {
  it("counts only companies with no office row at all", () => {
    const rows = [company(), company(), company({ offices: [office(1, "Lehi", "Utah")] })];
    expect(noLocationCount(rows)).toBe(2);
  });
});

describe("parseLocationSelection", () => {
  it("is inactive for an empty selection", () => {
    expect(parseLocationSelection([]).active).toBe(false);
  });

  it("stays ACTIVE when every value is unparseable", () => {
    // A shared link naming a city the recipient does not have must narrow to
    // nothing, not fall back to an unfiltered list that looks like the sender's.
    const s = parseLocationSelection(["c:banana"]);
    expect(s.active).toBe(true);
    expect(s.cities.size).toBe(0);
  });
});

describe("matchedOffices", () => {
  it("returns nothing when the selection is inactive", () => {
    const c = company({ offices: [office(1, "Lehi", "Utah")] });
    expect(matchedOffices(c, EMPTY_SELECTION)).toEqual([]);
  });

  it("returns every office a state value covers", () => {
    const c = company({ offices: [office(1, "Lehi", "Utah"), office(2, "Provo", "Utah"), office(3, "Boston", "Massachusetts")] });
    expect(matchedOffices(c, sel("s:Utah")).map((o) => o.location_id)).toEqual([1, 2]);
  });
});

describe("scopedCounts", () => {
  it("counts only people at the selected office", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")],
      roster: [
        person({ contact_id: 10, location_id: 1 }),
        person({ contact_id: 11, location_id: 1 }),
        person({ contact_id: 12, location_id: 2 }),
      ],
    });
    expect(scopedCounts(c, sel("c:1")).current).toBe(2);
    expect(scopedCounts(c, sel("c:2")).current).toBe(1);
  });

  it("counts a contact ONCE across two selected offices of the same company", () => {
    // The measured reason this is a roster and not a per-office count map: 493
    // contacts on the reference account hold roles at two or more different
    // offices of one company, and summing per-office counts double-counts them.
    const c = company({
      offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")],
      roster: [
        person({ contact_id: 10, location_id: 1 }),
        person({ contact_id: 10, location_id: 2 }),
      ],
    });
    expect(scopedCounts(c, sel("c:1", "c:2")).current).toBe(1);
  });

  it("reports unlocated contacts as unknown rather than dropping them", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah")],
      roster: [
        person({ contact_id: 10, location_id: 1 }),
        person({ contact_id: 11 }),
        person({ contact_id: 12 }),
      ],
    });
    const s = scopedCounts(c, sel("c:1"));
    expect(s.current).toBe(1);
    expect(s.unknown).toBe(2);
  });

  it("does not call a contact unknown just because they work at another office", () => {
    // "unknown" must mean "we have no idea where they are", never "somewhere
    // other than what you selected" — otherwise the remainder overstates the
    // blind spot every time a company has more than one office.
    const c = company({
      offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")],
      roster: [person({ contact_id: 10, location_id: 1 }), person({ contact_id: 11, location_id: 2 })],
    });
    expect(scopedCounts(c, sel("c:1")).unknown).toBe(0);
  });

  it("counts a remote contact as unknown, not as present at the office", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah")],
      roster: [person({ contact_id: 10, location_id: null, remote: true })],
    });
    const s = scopedCounts(c, sel("c:1"));
    expect(s.current).toBe(0);
    expect(s.unknown).toBe(1);
  });

  it("treats a boomeranger at one office as current there, not also former", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah")],
      roster: [
        person({ contact_id: 10, location_id: 1, is_current: false }),
        person({ contact_id: 10, location_id: 1, is_current: true }),
      ],
    });
    const s = scopedCounts(c, sel("c:1"));
    expect(s.current).toBe(1);
    expect(s.former).toBe(0);
  });

  it("scopes alum, product alum, recruiter and bench alongside the headcount", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")],
      roster: [
        person({ contact_id: 10, location_id: 1, alum: true, product_alum: true }),
        person({ contact_id: 11, location_id: 1, recruiter: true }),
        person({ contact_id: 12, location_id: 1, bench: true }),
        person({ contact_id: 13, location_id: 2, alum: true, product_alum: true }),
      ],
    });
    const s = scopedCounts(c, sel("c:1"));
    expect(s).toMatchObject({ current: 2, alum: 1, product_alum: 1, recruiter: 1, bench: 1 });
  });

  it("keeps bench out of the current count", () => {
    const c = company({
      offices: [office(1, "Lehi", "Utah")],
      roster: [person({ contact_id: 10, location_id: 1, bench: true })],
    });
    expect(scopedCounts(c, sel("c:1")).current).toBe(0);
  });

  it("ignores a roster location the company has no office row for", () => {
    // The dropdown only offers cities that exist as offices, so an employment
    // location with no matching office row is unreachable by any selection.
    const c = company({
      offices: [office(1, "Lehi", "Utah")],
      roster: [person({ contact_id: 10, location_id: 999 })],
    });
    expect(scopedCounts(c, sel("c:999")).current).toBe(0);
  });
});

describe("preselectedOffice / companyHref", () => {
  const twoOffices = () =>
    company({ offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")] });

  it("pre-selects the office when exactly one matches", () => {
    const c = twoOffices();
    expect(preselectedOffice(c, sel("c:1"))?.location_id).toBe(1);
    expect(companyHref(c, sel("c:1"))).toBe(`/companies/${c.id}?location=1`);
  });

  it("opens company-wide when two of the company's offices match", () => {
    const c = twoOffices();
    expect(preselectedOffice(c, sel("c:1", "c:2"))).toBeNull();
    expect(companyHref(c, sel("c:1", "c:2"))).toBe(`/companies/${c.id}`);
  });

  it("still pre-selects under a two-city filter when only ONE is this company's", () => {
    // The rule is about ambiguity for THIS company, not how many cities are
    // selected overall — a company with a single Lehi office should still open
    // to Lehi when the filter is Lehi + Boston.
    const c = company({ offices: [office(1, "Lehi", "Utah")] });
    expect(companyHref(c, sel("c:1", "c:2"))).toBe(`/companies/${c.id}?location=1`);
  });

  it("pre-selects a state click that resolves to one office", () => {
    const c = company({ offices: [office(1, "Lehi", "Utah"), office(2, "Boston", "Massachusetts")] });
    expect(companyHref(c, sel("s:Massachusetts"))).toBe(`/companies/${c.id}?location=2`);
  });

  it("opens company-wide for a state click covering two of its offices", () => {
    const c = company({ offices: [office(1, "Lehi", "Utah"), office(2, "Provo", "Utah")] });
    expect(companyHref(c, sel("s:Utah"))).toBe(`/companies/${c.id}`);
  });

  it("opens company-wide when no filter is active", () => {
    const c = twoOffices();
    expect(companyHref(c, EMPTY_SELECTION)).toBe(`/companies/${c.id}`);
  });

  it("opens company-wide for a `none` selection, which matches no office", () => {
    const c = company();
    expect(companyHref(c, sel("none"))).toBe(`/companies/${c.id}`);
  });
});
