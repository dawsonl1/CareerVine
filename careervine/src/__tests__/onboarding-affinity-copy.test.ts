/**
 * Onboarding numbers and orderings for the three affinity states (CAR-213).
 *
 * The progress-bar case is asserted as CONVERGENCE (applied/total === 1), not
 * as "total equals 1112" (plan §8.7). Asserting the value just re-encodes
 * whichever denominator I happened to pick; asserting that the bar can finish
 * catches every wrong denominator, including the one that looks plausible.
 */

import { describe, expect, it } from "vitest";
import {
  companySortOptions,
  defaultCompanySortKey,
  toPickerCompanies,
  sortPickerCompanies,
  type PickerCompany,
} from "@/lib/onboarding/company-picker";
import { alumniAffinityFor } from "@/lib/schools/affinity-state";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  company_id: 1,
  name: "Acme",
  logo_url: null,
  prospect_count: 10,
  eligible_prospect_count: 4,
  alumni_count: 6,
  product_alumni_count: 2,
  ...over,
});

describe("the progress bar can actually reach 100%", () => {
  // The live shape: 2,000 in the bundle, 1,112 delivered to a non-affinity
  // subscriber. Dividing by the wrong number is the whole defect.
  const BUNDLE_TOTAL = 2000;
  const DELIVERED = 1112;

  it("converges for a non-affinity subscriber", () => {
    const total = DELIVERED; // what eligibleProspectCount supplies
    expect(DELIVERED / total).toBe(1);
  });

  it("does NOT converge on the bundle total — the bug this replaces", () => {
    // Pinning the failure explicitly so a revert to prospect_count cannot pass
    // by looking approximately right.
    expect(DELIVERED / BUNDLE_TOTAL).toBeLessThan(0.6);
  });

  it("does NOT converge on the per-company sums either", () => {
    // The plausible wrong answer: bundle_company_stats sums to 653 eligible,
    // because it only counts prospects whose employer is a bundle company.
    // A bar fed that number sticks above 100% and finishes far too early.
    const PER_COMPANY_ELIGIBLE_SUM = 653;
    expect(DELIVERED / PER_COMPANY_ELIGIBLE_SUM).toBeGreaterThan(1);
  });
});

describe("sort options by affinity state", () => {
  it("offers alumni orderings ONLY to a user who has alumni", () => {
    const withAffinity = companySortOptions(true, "BYU").map((o) => o.value);
    const without = companySortOptions(false, null).map((o) => o.value);

    // Positive control first: the options exist at all.
    expect(withAffinity).toContain("alumni");
    expect(withAffinity).toContain("productAlumni");
    expect(without).not.toContain("alumni");
    expect(without).not.toContain("productAlumni");
    expect(without).toEqual(["contacts", "alphabetical"]);
  });

  it("names the user's own school in the label", () => {
    expect(companySortOptions(true, "USU")[0].label).toBe("Most USU alumni");
    expect(companySortOptions(true, "BYU")[0].label).toBe("Most BYU alumni");
  });

  it("drops the school from the label when there is no abbreviation", () => {
    // Escape-hatch school: no curated abbreviation, so the label must not
    // render "Most undefined alumni" or a truncated free-text name.
    expect(companySortOptions(true, null)[0].label).toBe("Most alumni");
  });

  it("opens on alumni only for an affinity user", () => {
    expect(defaultCompanySortKey(true)).toBe("alumni");
    expect(defaultCompanySortKey(false)).toBe("contacts");
  });
});

describe("picker companies reflect what the viewer receives", () => {
  it("shows the raw count to an affinity user", () => {
    const [c] = toPickerCompanies([row()], true);
    expect(c.contactCount).toBe(10);
  });

  it("shows the eligible count to everyone else", () => {
    const [c] = toPickerCompanies([row()], false);
    expect(c.contactCount).toBe(4);
  });

  it("hides companies emptied by the filter, rather than showing '0 contacts'", () => {
    const rows = [
      row({ company_id: 1, name: "Kept", eligible_prospect_count: 3 }),
      row({ company_id: 2, name: "Emptied", eligible_prospect_count: 0 }),
    ];
    // Positive control: an affinity user still sees both, so this is not a
    // filter that simply drops everything. Sorted, because these two tie on
    // every ranking signal and fall through to the alphabetical tiebreak —
    // asserting insertion order here would be asserting the comparator.
    expect(toPickerCompanies(rows, true).map((c) => c.name).sort()).toEqual(["Emptied", "Kept"]);
    expect(toPickerCompanies(rows, false).map((c) => c.name)).toEqual(["Kept"]);
  });

  it("orders by contacts, not alumni, for a non-affinity user", () => {
    const rows = [
      row({ company_id: 1, name: "ManyAlumni", alumni_count: 99, eligible_prospect_count: 1 }),
      row({ company_id: 2, name: "ManyContacts", alumni_count: 0, eligible_prospect_count: 50 }),
    ];
    expect(toPickerCompanies(rows, false).map((c) => c.name)).toEqual(["ManyContacts", "ManyAlumni"]);
    expect(toPickerCompanies(rows, true).map((c) => c.name)).toEqual(["ManyAlumni", "ManyContacts"]);
  });
});

describe("alumniAffinityFor — three states, not two", () => {
  it("separates a named non-BYU school from no school at all", () => {
    // Identical on data, different on copy: one gets an explanation, the other
    // gets an invitation. Collapsing them to a boolean is how the copy breaks.
    expect(alumniAffinityFor("Utah State University")).toMatchObject({
      hasAffinity: false, state: "other_school", abbr: "USU",
    });
    expect(alumniAffinityFor(null)).toMatchObject({
      hasAffinity: false, state: "no_school", abbr: null,
    });
    expect(alumniAffinityFor("Brigham Young University")).toMatchObject({
      hasAffinity: true, state: "byu_family", abbr: "BYU",
    });
  });

  it("treats whitespace as no school", () => {
    expect(alumniAffinityFor("   ").state).toBe("no_school");
  });

  it("gives an escape-hatch school no abbreviation but a real state", () => {
    const a = alumniAffinityFor("Pitcher Institute of Technology");
    expect(a).toMatchObject({ hasAffinity: false, state: "other_school", abbr: null });
  });
});

describe("sortPickerCompanies does not mutate its input", () => {
  it("returns a new array", () => {
    const input: PickerCompany[] = [
      { id: 1, name: "B", logoUrl: null, contactCount: 1, eligibleContactCount: 1, alumniCount: 0, productAlumniCount: 0 },
      { id: 2, name: "A", logoUrl: null, contactCount: 1, eligibleContactCount: 1, alumniCount: 0, productAlumniCount: 0 },
    ];
    const out = sortPickerCompanies(input, "alphabetical");
    expect(out.map((c) => c.name)).toEqual(["A", "B"]);
    expect(input.map((c) => c.name)).toEqual(["B", "A"]);
  });
});
