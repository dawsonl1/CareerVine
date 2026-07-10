import { describe, it, expect } from "vitest";
import {
  partitionDiscoveryItems,
  buildCandidatePeopleRecord,
  selectDiscoveryCompanies,
  normalizeName,
  type ApifyDiscoveryItem,
  type DiscoveryPartitionContext,
} from "@/lib/apify/discovery";
import { estimateRunCostUsd } from "@/lib/apify/spend";
import { mapPeopleRecord } from "@/lib/scrape-mapper";
import { DISCOVERY_PAGE_COST_USD, SCRAPE_UNIT_COST_USD } from "@/lib/constants";

/**
 * Item shape mirrors the live actor-C probe (2026-07-10): internal member-id
 * linkedinUrl, no publicIdentifier/headline/name fields, summary as the
 * headline, pictureUrl, currentPositions[].
 */
function probeItem(overrides: Partial<ApifyDiscoveryItem> = {}): ApifyDiscoveryItem {
  return {
    id: "ACwAAAtest0001",
    linkedinUrl: "https://www.linkedin.com/in/ACwAAAtest0001",
    firstName: "Jordan",
    lastName: "Rivera",
    summary: "Senior PM building agentic workflows",
    pictureUrl: "https://media.licdn.com/dms/image/photo.jpg",
    location: { linkedinText: "San Francisco Bay Area" },
    currentPositions: [
      {
        title: "Senior Product Manager",
        companyName: "Adobe",
        companyId: "1480",
        companyLinkedinUrl: "https://www.linkedin.com/company/1480",
        startedOn: { month: 6, year: 2026 },
        current: true,
      },
    ],
    ...overrides,
  };
}

function emptyCtx(overrides: Partial<DiscoveryPartitionContext> = {}): DiscoveryPartitionContext {
  return {
    existingContactUrls: new Set(),
    suppressedUrls: new Set(),
    contactNamesAtCompany: new Set(),
    companyLinkedinId: "1480",
    ...overrides,
  };
}

describe("partitionDiscoveryItems (plan 41)", () => {
  it("normalizes a probe-shaped item into a candidate draft", () => {
    const { drafts, dropped } = partitionDiscoveryItems([probeItem()], emptyCtx());
    expect(dropped).toEqual({ invalid: 0, existing: 0, suppressed: 0 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      linkedinUrl: "https://www.linkedin.com/in/ACwAAAtest0001",
      publicIdentifier: null, // internal member id has no vanity slug
      name: "Jordan Rivera",
      headline: "Senior PM building agentic workflows",
      location: "San Francisco Bay Area",
      photoUrl: "https://media.licdn.com/dms/image/photo.jpg",
      position: "Senior Product Manager",
    });
  });

  it("preserves internal member-id case in the canonical URL", () => {
    const { drafts } = partitionDiscoveryItems(
      [probeItem({ linkedinUrl: "https://www.linkedin.com/in/ACwAAAtESt0001" })],
      emptyCtx(),
    );
    expect(drafts[0].linkedinUrl).toBe("https://www.linkedin.com/in/ACwAAAtESt0001");
  });

  it("drops items with no usable URL or name, and in-page duplicates", () => {
    const { drafts, dropped } = partitionDiscoveryItems(
      [
        probeItem({ linkedinUrl: null }),
        probeItem({ firstName: null, lastName: null }),
        probeItem(),
        probeItem(), // duplicate URL within the same page
      ],
      emptyCtx(),
    );
    expect(drafts).toHaveLength(1);
    expect(dropped.invalid).toBe(3);
  });

  it("drops existing contacts by canonical URL", () => {
    const { drafts, dropped } = partitionDiscoveryItems(
      [probeItem()],
      emptyCtx({ existingContactUrls: new Set(["https://www.linkedin.com/in/ACwAAAtest0001"]) }),
    );
    expect(drafts).toHaveLength(0);
    expect(dropped.existing).toBe(1);
  });

  it("drops existing contacts by name-at-company (internal URLs defeat URL matching)", () => {
    const { drafts, dropped } = partitionDiscoveryItems(
      [probeItem()],
      emptyCtx({ contactNamesAtCompany: new Set([normalizeName("  Jordan   RIVERA ")]) }),
    );
    expect(drafts).toHaveLength(0);
    expect(dropped.existing).toBe(1);
  });

  it("drops suppressed (tombstoned) URLs", () => {
    const { drafts, dropped } = partitionDiscoveryItems(
      [probeItem()],
      emptyCtx({ suppressedUrls: new Set(["https://www.linkedin.com/in/ACwAAAtest0001"]) }),
    );
    expect(drafts).toHaveLength(0);
    expect(dropped.suppressed).toBe(1);
  });

  it("picks the position at the searched company over an earlier entry", () => {
    const item = probeItem({
      currentPositions: [
        { title: "Advisor", companyName: "SomeStartup", companyId: "999" },
        { title: "Group PM", companyName: "Adobe", companyId: "1480" },
      ],
    });
    const { drafts } = partitionDiscoveryItems([item], emptyCtx({ companyLinkedinId: "1480" }));
    expect(drafts[0].position).toBe("Group PM");
  });

  it("falls back to the first position when the company id is unknown", () => {
    const item = probeItem({
      currentPositions: [{ title: "Advisor", companyName: "SomeStartup", companyId: "999" }],
    });
    const { drafts } = partitionDiscoveryItems([item], emptyCtx({ companyLinkedinId: null }));
    expect(drafts[0].position).toBe("Advisor");
  });

  it("tolerates items with no currentPositions (probe: 1/25 lacked them)", () => {
    const { drafts } = partitionDiscoveryItems([probeItem({ currentPositions: null })], emptyCtx());
    expect(drafts[0].position).toBeNull();
  });
});

describe("buildCandidatePeopleRecord → mapPeopleRecord (mapper contract)", () => {
  const candidate = {
    name: "Jordan Rivera",
    linkedin_url: "https://www.linkedin.com/in/ACwAAAtest0001",
    headline: "Senior PM building agentic workflows",
    location: "San Francisco Bay Area",
    photo_url: "https://media.licdn.com/dms/image/photo.jpg",
    position: "Senior Product Manager",
    raw: probeItem(),
  };
  const company = {
    name: "Adobe",
    linkedin_url: "https://www.linkedin.com/company/adobe",
    linkedin_company_id: "1480",
  };

  it("produces a record the real mapper accepts as a clean prospect", () => {
    const mapped = mapPeopleRecord(buildCandidatePeopleRecord(candidate, company));
    expect(mapped.name).toBe("Jordan Rivera");
    expect(mapped.linkedin_url).toBe("https://www.linkedin.com/in/ACwAAAtest0001");
    expect(mapped.network_status).toBe("prospect");
    expect(mapped.import_source).toBe("apify:discovery");
    // No unknown_selected_contact / no_employment_rows noise — only the
    // expected non-vanity warning for an internal member-id URL.
    expect(mapped.warnings).toEqual(["non_vanity_url"]);
  });

  it("threads the known company LinkedIn identity into the employment row", () => {
    const mapped = mapPeopleRecord(buildCandidatePeopleRecord(candidate, company));
    expect(mapped.employment).toHaveLength(1);
    expect(mapped.employment[0]).toMatchObject({
      title: "Senior Product Manager",
      company_name: "Adobe",
      linkedin_company_id: "1480", // matches the existing companies row — no name-ilike duplicate
      company_linkedin_url: "https://www.linkedin.com/company/adobe",
      is_current: true,
      start_month: "Jun 2026", // numeric startedOn month converted for the mapper
    });
  });

  it("carries photo, headline, and location through the raw profile", () => {
    const mapped = mapPeopleRecord(buildCandidatePeopleRecord(candidate, company));
    expect(mapped.photo_url).toBe("https://media.licdn.com/dms/image/photo.jpg");
    expect(mapped.headline).toBe("Senior PM building agentic workflows");
    expect(mapped.profile_location_raw).toBe("San Francisco Bay Area");
  });

  it("survives a candidate with no position and no raw currentPositions", () => {
    const bare = { ...candidate, position: null, raw: { linkedinUrl: candidate.linkedin_url } };
    const mapped = mapPeopleRecord(buildCandidatePeopleRecord(bare, company));
    // Employment row still lands (company identity known), title just empty.
    expect(mapped.employment).toHaveLength(1);
    expect(mapped.employment[0].title).toBeNull();
    expect(mapped.employment[0].start_month).toBeNull();
  });
});

describe("estimateRunCostUsd (plan 41 §3.5)", () => {
  it("prices discovery runs per page, not per contact", () => {
    expect(estimateRunCostUsd("discovery", 0, SCRAPE_UNIT_COST_USD.email)).toBe(DISCOVERY_PAGE_COST_USD);
  });

  it("keeps the contact-count formula for scrape modes", () => {
    expect(estimateRunCostUsd("profile", 25, SCRAPE_UNIT_COST_USD.email)).toBeCloseTo(0.1);
    expect(estimateRunCostUsd("email", 1, SCRAPE_UNIT_COST_USD.profile)).toBeCloseTo(0.01);
    // Empty contact_ids still reserves one unit (Math.max floor).
    expect(estimateRunCostUsd("profile", 0, SCRAPE_UNIT_COST_USD.email)).toBeCloseTo(0.004);
  });

  it("falls back to the given unit for unknown modes", () => {
    expect(estimateRunCostUsd("mystery", 2, SCRAPE_UNIT_COST_USD.email)).toBeCloseTo(0.02);
  });
});

// ── selectDiscoveryCompanies against a PostgREST-shaped stub ────────────

interface StubData {
  pendingCompanyIds: number[];
  targetRows: Array<{
    company_id: number;
    last_discovery_at: string | null;
    priority_score: number | null;
    companies: { id: number; name: string; linkedin_url: string | null; linkedin_company_id: string | null };
  }>;
}

function stubService(data: StubData) {
  return {
    from: (table: string) => {
      if (table === "scrape_runs") {
        const rows = data.pendingCompanyIds.map((id) => ({ company_id: id }));
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: { data: unknown }) => void) => resolve({ data: rows }),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        then: (resolve: (v: { data: unknown }) => void) => resolve({ data: data.targetRows }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof selectDiscoveryCompanies>[0];
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function target(
  companyId: number,
  opts: { last?: string | null; priority?: number | null; url?: string | null } = {},
) {
  return {
    company_id: companyId,
    last_discovery_at: opts.last ?? null,
    priority_score: opts.priority ?? null,
    companies: {
      id: companyId,
      name: `Company ${companyId}`,
      linkedin_url: opts.url === undefined ? `https://www.linkedin.com/company/c${companyId}` : opts.url,
      linkedin_company_id: String(companyId),
    },
  };
}

describe("selectDiscoveryCompanies (plan 41 §3.2)", () => {
  it("orders never-searched first, then stalest, then priority", async () => {
    const service = stubService({
      pendingCompanyIds: [],
      targetRows: [
        target(1, { last: daysAgo(40), priority: 90 }),
        target(2, { last: null, priority: 10 }),
        target(3, { last: daysAgo(90), priority: 50 }),
        target(4, { last: null, priority: 99 }),
      ],
    });
    const picked = await selectDiscoveryCompanies(service, "u-1", 10);
    expect(picked.map((c) => c.companyId)).toEqual([4, 2, 3, 1]);
  });

  it("excludes companies searched within the min-age window", async () => {
    const service = stubService({
      pendingCompanyIds: [],
      targetRows: [target(1, { last: daysAgo(5) }), target(2, { last: daysAgo(45) })],
    });
    const picked = await selectDiscoveryCompanies(service, "u-1", 10);
    expect(picked.map((c) => c.companyId)).toEqual([2]);
  });

  it("excludes companies with a pending discovery run", async () => {
    const service = stubService({
      pendingCompanyIds: [1],
      targetRows: [target(1), target(2)],
    });
    const picked = await selectDiscoveryCompanies(service, "u-1", 10);
    expect(picked.map((c) => c.companyId)).toEqual([2]);
  });

  it("dedupes scoped target rows to one entry per company, keeping the freshest stamp and best priority", async () => {
    const service = stubService({
      pendingCompanyIds: [],
      targetRows: [
        target(1, { last: daysAgo(100), priority: 10 }), // company-wide row
        target(1, { last: daysAgo(5), priority: 80 }), // office-scoped row, stamped recently
        target(2, { last: daysAgo(60) }),
      ],
    });
    const picked = await selectDiscoveryCompanies(service, "u-1", 10);
    // Company 1's freshest stamp (5d) is inside the 30d window → excluded entirely.
    expect(picked.map((c) => c.companyId)).toEqual([2]);
  });

  it("skips companies without a LinkedIn URL and respects the limit", async () => {
    const service = stubService({
      pendingCompanyIds: [],
      targetRows: [target(1, { url: null }), target(2), target(3), target(4)],
    });
    const picked = await selectDiscoveryCompanies(service, "u-1", 2);
    expect(picked).toHaveLength(2);
    expect(picked.every((c) => c.companyId !== 1)).toBe(true);
  });
});
