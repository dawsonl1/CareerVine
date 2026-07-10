import { describe, it, expect } from "vitest";
import {
  computeContactPatch,
  computeEmploymentMerge,
  type ExistingEmploymentRow,
  type IncomingEmploymentRow,
} from "@/lib/scrape-merge";
import type { MappedPerson } from "@/lib/scrape-mapper";

const NOW = "2026-07-09T00:00:00.000Z";

function existingRow(overrides: Partial<ExistingEmploymentRow> = {}): ExistingEmploymentRow {
  return {
    id: 1, company_id: 10, title: "PM", start_month: "Jan 2023", end_month: "Present",
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: "Full-time", source: "scraped",
    ...overrides,
  };
}

function incomingRow(overrides: Partial<IncomingEmploymentRow> = {}): IncomingEmploymentRow {
  return {
    company_id: 10, title: "PM", start_month: "Jan 2023", end_month: "Present",
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: "Full-time",
    ...overrides,
  };
}

// A synthetic rescrape record maps with NO pipeline block, so these defaults
// mimic the corruption a naive reuse would apply if the mode flag were ignored.
const rescrapeMapped = {
  name: "Jane Doe",
  headline: "Director of Product at Domo",
  persona: "recruiter",           // would clobber a real persona
  review_note: "synthetic",       // would wipe the AI review note
  verified_school: "none",        // would downgrade a BYU badge
  import_source: "apify:rescrape", // would wipe pipeline provenance
  import_meta: { history: [] },    // would wipe priority_rank/verdicts
  public_identifier: "jane-doe",
  network_status: "prospect",      // would promote bench→prospect
  network_scope: "target_company", // would mislabel a non-pipeline contact
} as unknown as MappedPerson;

describe("computeContactPatch — rescrape mode (B1)", () => {
  const existing = { id: 1, name: "Jane Doe", persona: "alum_product", network_status: "bench", location_id: null, headline: "old" };

  it("never touches pipeline- or user-owned fields", () => {
    const { patch, personaConflict } = computeContactPatch(existing, rescrapeMapped, NOW, 42, "rescrape");
    expect(patch.network_status).toBeUndefined();
    expect(patch.network_scope).toBeUndefined();
    expect(patch.import_source).toBeUndefined();
    expect(patch.import_meta).toBeUndefined();
    expect(patch.review_note).toBeUndefined();
    expect(patch.persona).toBeUndefined();
    expect(patch.verified_school).toBeUndefined();
    expect(personaConflict).toBeNull();
  });

  it("refreshes observed profile data and staleness", () => {
    const { patch } = computeContactPatch(existing, rescrapeMapped, NOW, 42, "rescrape");
    expect(patch.last_scraped_at).toBe(NOW);
    expect(patch.headline).toBe("Director of Product at Domo");
    expect(patch.public_identifier).toBe("jane-doe");
    expect(patch.location_id).toBe(42); // contact had none
  });

  it("still respects manual wins for name and location", () => {
    const withData = { ...existing, name: "Real Name", location_id: 7 };
    const { patch } = computeContactPatch(withData, rescrapeMapped, NOW, 42, "rescrape");
    expect(patch.name).toBeUndefined();
    expect(patch.location_id).toBeUndefined();
  });

  it("refreshes a placeholder name", () => {
    const { patch } = computeContactPatch({ ...existing, name: "Unknown" }, rescrapeMapped, NOW, null, "rescrape");
    expect(patch.name).toBe("Jane Doe");
  });

  it("pipeline policy is unchanged (regression guard)", () => {
    const { patch } = computeContactPatch(existing, rescrapeMapped, NOW, null, "pipeline");
    expect(patch.import_source).toBe("apify:rescrape");
    expect(patch.network_status).toBe("prospect"); // bench follows incoming
  });

  it("defaults to pipeline policy when none is passed", () => {
    const { patch } = computeContactPatch(existing, rescrapeMapped, NOW, null);
    expect(patch.import_source).toBe("apify:rescrape");
  });
});

describe("computeEmploymentMerge — currentCollisionStrategy 'skip' (M2 interim, rescrape default)", () => {
  it("leaves a possibly user-typed current role untouched and drops the duplicate", () => {
    const existing = [existingRow({ id: 5, source: "manual", title: "Product Manager", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior Product Manager", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "skip" });
    // No clobber, no duplicate — just a freshness confirmation on the existing row.
    expect(plan.inserts).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.updates).toEqual([{ id: 5, fields: { scraped_at: NOW } }]);
  });

  it("does not skip at a DIFFERENT company (real job change still inserts)", () => {
    const existing = [existingRow({ id: 5, source: "manual", company_id: 10, title: "PM", start_month: "2022" })];
    const incoming = [incomingRow({ company_id: 99, title: "PM", start_month: "Mar 2022" })];
    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "skip" });
    expect(plan.inserts).toHaveLength(1);
  });
});

describe("computeEmploymentMerge — currentCollisionStrategy 'reconcile' (rescrape default)", () => {
  it("supersedes an AI-parsed 'extension' current role in place", () => {
    const existing = [existingRow({ id: 5, source: "extension", title: "Product Manager", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior Product Manager", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "reconcile" });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].fields).toMatchObject({
      title: "Senior Product Manager",
      start_month: "Mar 2022",
      source: "scraped",
      scraped_at: NOW,
    });
  });

  it("supersedes a stale 'scraped' current role in place (preserves row identity)", () => {
    const existing = [existingRow({ id: 5, source: "scraped", title: "PM", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Group PM", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "reconcile" });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe(5);
    expect(plan.updates[0].fields.title).toBe("Group PM");
    expect(plan.deleteIds).toHaveLength(0); // superseded, not delete+reinsert
  });

  it("never touches a user-typed 'manual' current role (skip semantics)", () => {
    const existing = [existingRow({ id: 5, source: "manual", title: "Product Manager", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior Product Manager", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "reconcile" });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.updates).toEqual([{ id: 5, fields: { scraped_at: NOW } }]);
  });

  it("still inserts a genuine job change at a different company", () => {
    const existing = [existingRow({ id: 5, source: "extension", company_id: 10, title: "PM", start_month: "2022" })];
    const incoming = [incomingRow({ company_id: 99, title: "PM", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "reconcile" });
    expect(plan.inserts).toHaveLength(1);
  });
});

describe("computeEmploymentMerge — currentCollisionStrategy 'supersede' (future, with source model)", () => {
  it("supersedes an AI-parsed current role instead of duplicating it", () => {
    // Extension saved a rough current role; the scrape brings the real one.
    const existing = [existingRow({ id: 5, source: "manual", title: "Product Manager", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior Product Manager", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "supersede" });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe(5);
    expect(plan.updates[0].fields).toMatchObject({
      title: "Senior Product Manager",
      start_month: "Mar 2022",
      source: "scraped",
      scraped_at: NOW,
    });
  });

  it("without the flag, the same case duplicates (documents the default)", () => {
    const existing = [existingRow({ id: 5, source: "manual", title: "Product Manager", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior Product Manager", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW);
    expect(plan.inserts).toHaveLength(1);
    // Manual row untouched except the freshness stamp is not applied (no key match)
    expect(plan.deleteIds).toHaveLength(0);
  });

  it("only supersedes at the SAME company", () => {
    const existing = [existingRow({ id: 5, source: "manual", company_id: 10, title: "PM", start_month: "2022" })];
    const incoming = [incomingRow({ company_id: 99, title: "PM", start_month: "Mar 2022" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "supersede" });
    expect(plan.inserts).toHaveLength(1); // different company → real job change, insert
    expect(plan.updates).toHaveLength(0);
  });

  it("does not supersede non-current existing rows", () => {
    const existing = [existingRow({ id: 5, source: "manual", is_current: false, end_month: "Dec 2023", title: "Old", start_month: "2020" })];
    const incoming = [incomingRow({ title: "New", start_month: "Mar 2024" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "supersede" });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("preserves a deliberately user-set location when superseding", () => {
    const existing = [existingRow({ id: 5, source: "manual", location_source: "manual", location_id: 77, title: "PM", start_month: "2022" })];
    const incoming = [incomingRow({ title: "Senior PM", start_month: "Mar 2022", location_id: 88, location_source: "experience" })];

    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "supersede" });
    expect(plan.updates[0].fields.location_id).toBeUndefined(); // manual location kept
    expect(plan.updates[0].fields.title).toBe("Senior PM");
  });

  it("still matches exactly by natural key before superseding", () => {
    // Exact key match must win (normal update), not a supersede.
    const existing = [existingRow({ id: 5, source: "scraped" })];
    const incoming = [incomingRow()];
    const plan = computeEmploymentMerge(existing, incoming, NOW, { currentCollisionStrategy: "supersede" });
    expect(plan.updates).toHaveLength(1);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates[0].fields.source).toBeUndefined(); // plain freshness update, not a supersede
  });
});
