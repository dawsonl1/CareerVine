import { describe, expect, it } from "vitest";
import { personInFacet } from "@/lib/company-scopes";
import type { CompanyPerson } from "@/lib/company-queries";

type Role = CompanyPerson["roles"][number];

function role(overrides: Partial<Role>): Role {
  return {
    id: 1,
    title: null,
    is_current: true,
    start_month: null,
    end_month: null,
    location_id: null,
    location_label: null,
    location_city: null,
    location_state: null,
    location_country: null,
    workplace_type: null,
    ...overrides,
  };
}

function person(contact_id: number, roles: Partial<Role>[]): CompanyPerson {
  return {
    contact_id,
    name: `Person ${contact_id}`,
    photo_url: null,
    headline: null,
    persona: null,
    network_status: "active",
    is_alum: false,
    review_note: null,
    selection_reason: null,
    last_scraped_at: null,
    linkedin_url: null,
    stage: null,
    email: null,
    last_interaction: null,
    adjacency_score: null,
    current_position: null,
    roles: roles.map(role),
  };
}

/**
 * Reference implementation of the OLD per-facet scoping: getCompanyDetail built
 * `scopedIds` from the raw employment rows and included a contact if any of its
 * rows matched the facet key. Since a person's `roles` == that contact's rows,
 * `personInFacet` must agree with this for every key. (CAR-93)
 */
function oldScopeMatch(p: CompanyPerson, key: string): boolean {
  return p.roles.some((r) =>
    key === "remote"
      ? r.workplace_type === "remote"
      : key === "unknown"
        ? r.workplace_type !== "remote" && r.location_id == null
        : String(r.location_id) === key,
  );
}

describe("personInFacet", () => {
  it("matches an office facet by location_id", () => {
    const p = person(1, [{ location_id: 5 }]);
    expect(personInFacet(p, "5")).toBe(true);
    expect(personInFacet(p, "6")).toBe(false);
  });

  it("matches 'remote' only for remote roles", () => {
    const remote = person(1, [{ workplace_type: "remote", location_id: null }]);
    const onsite = person(2, [{ workplace_type: "on_site", location_id: 5 }]);
    expect(personInFacet(remote, "remote")).toBe(true);
    expect(personInFacet(onsite, "remote")).toBe(false);
  });

  it("matches 'unknown' only for non-remote roles with no location", () => {
    const unknown = person(1, [{ workplace_type: null, location_id: null }]);
    const remote = person(2, [{ workplace_type: "remote", location_id: null }]);
    const located = person(3, [{ workplace_type: null, location_id: 9 }]);
    expect(personInFacet(unknown, "unknown")).toBe(true);
    expect(personInFacet(remote, "unknown")).toBe(false);
    expect(personInFacet(located, "unknown")).toBe(false);
  });

  it("matches a facet if ANY role qualifies (multi-role people)", () => {
    // Worked in office 5, then moved to office 8 — belongs to both facets.
    const p = person(1, [
      { location_id: 5, is_current: false },
      { location_id: 8, is_current: true },
    ]);
    expect(personInFacet(p, "5")).toBe(true);
    expect(personInFacet(p, "8")).toBe(true);
    expect(personInFacet(p, "9")).toBe(false);
  });

  it("agrees with the old per-facet scoping across a mixed roster", () => {
    const people = [
      person(1, [{ location_id: 5 }]),
      person(2, [{ workplace_type: "remote", location_id: null }]),
      person(3, [{ workplace_type: null, location_id: null }]),
      person(4, [
        { location_id: 5, is_current: false },
        { location_id: 8, is_current: true },
      ]),
      person(5, [{ workplace_type: "remote", location_id: 5 }]),
    ];
    const keys = ["5", "8", "remote", "unknown", "999"];
    for (const key of keys) {
      const derived = people.filter((p) => personInFacet(p, key)).map((p) => p.contact_id);
      const reference = people.filter((p) => oldScopeMatch(p, key)).map((p) => p.contact_id);
      expect(derived).toEqual(reference);
    }
  });

  it("filtering a sorted base bucket preserves order", () => {
    // base.current arrives pre-sorted; slicing must not reorder.
    const base = [
      person(10, [{ location_id: 5 }]),
      person(20, [{ location_id: 8 }]),
      person(30, [{ location_id: 5 }]),
      person(40, [{ location_id: 5 }]),
    ];
    const sliced = base.filter((p) => personInFacet(p, "5")).map((p) => p.contact_id);
    expect(sliced).toEqual([10, 30, 40]);
  });
});
