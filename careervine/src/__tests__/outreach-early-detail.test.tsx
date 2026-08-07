// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyDetail, CompanySummary } from "@/lib/company-queries";

/**
 * /outreach paints from the QUEUE, not from the company detail (CAR-229).
 *
 * The flow shows one company at a time and the people grid is its largest
 * element, so whatever renders in that region is what LCP waits on. Two things
 * kept it waiting, and each has a test here:
 *
 *  1. The detail fetch was chained behind the queue fetch even when the URL
 *     already named the company. Every step through the flow writes
 *     `?company=<id>`, so a reload, a bookmark or a return from the company page
 *     arrives knowing exactly which company to open — and used to spend the
 *     whole getCompanies round trip finding out anyway.
 *
 *  2. While the detail was in flight the region was one line of text, which the
 *     real grid then displaced. The queue entry already carries the count, so
 *     the region can paint at full size immediately.
 *
 * Both are asserted against ORDERING, not timing: the queue promise is held open
 * by the test, so a detail request that only fires after it cannot pass.
 */

const q = vi.hoisted(() => ({
  getCompanies: vi.fn(),
  getCompanyDetail: vi.fn(),
}));

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("@/lib/company-queries", () => ({
  getCompanies: q.getCompanies,
  getCompanyDetail: q.getCompanyDetail,
}));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: () => {}, isOpen: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}));

import OutreachPage from "@/app/outreach/page";

function summary(id: number, name: string, currentCount: number): CompanySummary {
  return {
    id,
    name,
    logo_url: null,
    linkedin_url: null,
    current_count: currentCount,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    target: { status: "open" } as CompanySummary["target"],
    office_scopes: [],
    traction: null,
    traction_detail: null,
    lead_detail: null,
  };
}

function detail(id: number, name: string, personName: string): CompanyDetail {
  return {
    company: { id, name, logo_url: null, linkedin_url: null, universal_name: null },
    target: null,
    offices: [],
    facets: [],
    current: [
      {
        contact_id: id * 100,
        name: personName,
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
        email: { address: `${personName}@x.com`, source: "verified", bounced: false },
        last_interaction: null,
        adjacency_score: null,
        roles: [],
      } as unknown as CompanyDetail["current"][number],
    ],
    former: [],
    bench: [],
  };
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  q.getCompanies.mockReset();
  q.getCompanyDetail.mockReset();
  q.getCompanyDetail.mockResolvedValue(detail(2, "Globex", "Bob"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/outreach paints from the queue (CAR-229)", () => {
  it("fetches the URL's company WITHOUT waiting for the queue", async () => {
    nav.params = new URLSearchParams("company=2");
    // Held open: nothing about the queue is known while the assertion below
    // runs, so a detail request issued here provably did not wait for it.
    let releaseQueue!: (s: CompanySummary[]) => void;
    q.getCompanies.mockReturnValue(
      new Promise<CompanySummary[]>((resolve) => { releaseQueue = resolve; }),
    );

    await act(async () => { render(<OutreachPage />); });

    expect(q.getCompanies).toHaveBeenCalledTimes(1);
    expect(q.getCompanyDetail).toHaveBeenCalledTimes(1);
    expect(q.getCompanyDetail.mock.calls[0][1]).toBe(2);

    // And the queue landing on the SAME company does not refire it — the two
    // agree, so there is nothing to reload.
    await act(async () => {
      releaseQueue([summary(1, "Acme", 3), summary(2, "Globex", 3)]);
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeDefined());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Globex");
    expect(q.getCompanyDetail).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a detail the empty-queue card will never show", async () => {
    nav.params = new URLSearchParams("company=2");
    let releaseQueue!: (s: CompanySummary[]) => void;
    q.getCompanies.mockReturnValue(
      new Promise<CompanySummary[]>((resolve) => { releaseQueue = resolve; }),
    );

    await act(async () => { render(<OutreachPage />); });
    expect(q.getCompanyDetail).toHaveBeenCalledTimes(1);

    // Nothing contactable: the page renders its empty state, so the detail is
    // work nobody will ever see. It must not be re-issued.
    await act(async () => { releaseQueue([]); });
    await waitFor(() =>
      expect(screen.getByText(/No target companies with contactable people yet/)).toBeDefined(),
    );
    expect(q.getCompanyDetail).toHaveBeenCalledTimes(1);
  });

  it("ignores a junk ?company and still opens the front of the queue", async () => {
    nav.params = new URLSearchParams("company=not-a-number");
    q.getCompanies.mockResolvedValue([summary(1, "Acme", 3), summary(2, "Globex", 3)]);
    q.getCompanyDetail.mockResolvedValue(detail(1, "Acme", "Alice"));

    await act(async () => { render(<OutreachPage />); });

    await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
    // Never asked for NaN, and asked for the queue front exactly once.
    expect(q.getCompanyDetail.mock.calls.map((c) => c[1])).toEqual([1]);
  });

  it("paints the people region from the queue entry's count while detail loads", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme", 4)]);
    let releaseDetail!: (d: CompanyDetail) => void;
    q.getCompanyDetail.mockReturnValue(
      new Promise<CompanyDetail>((resolve) => { releaseDetail = resolve; }),
    );

    await act(async () => { render(<OutreachPage />); });

    // The heading and its count come from the queue entry, which is already in
    // memory — so this renders before getCompanyDetail has resolved anything.
    await waitFor(() => expect(screen.getByText("Current employees (4)")).toBeDefined());
    expect(screen.queryByText("Alice")).toBeNull();

    await act(async () => { releaseDetail(detail(1, "Acme", "Alice")); });

    // Detail fills the same region in: one heading, now backed by real people.
    await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
    expect(screen.getAllByText(/^Current employees \(/)).toHaveLength(1);
  });
});
