// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyDetail, CompanySummary } from "@/lib/company-queries";

/**
 * CAR-190: the outreach page's company detail fetch was identity-keyed on the
 * company and gated on nothing.
 *
 * ←/→ and the jump Select both change `company` and refire the load, and
 * getCompanyDetail runs three sequential waves that scale with employee count,
 * so the latency spread between two in-flight companies is structural. Ungated,
 * the slower response won last: the page rendered one company's header over
 * another's employees, and clicking a person there opened a compose prefilled
 * to someone at the other company.
 *
 * Two separate defects, so two separate tests. The gate stops the stale
 * response committing; clearing `detail` on company change stops the previous
 * company's people rendering under the new header for the whole fetch, which
 * happened on every navigation after the first because the render gate is
 * `detailLoading && !detail`.
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
  useCompose: () => ({ openCompose: vi.fn(), isOpen: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}));

import OutreachPage from "@/app/outreach/page";

function summary(id: number, name: string): CompanySummary {
  return {
    id,
    name,
    logo_url: null,
    linkedin_url: null,
    current_count: 1,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    target: { status: "open" } as CompanySummary["target"],
    office_scopes: [],
    traction: null,
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

/** A getCompanyDetail whose responses resolve only when the test says so. */
function deferredDetails() {
  const pending = new Map<number, (d: CompanyDetail) => void>();
  q.getCompanyDetail.mockImplementation(
    (_userId: string, companyId: number) =>
      new Promise<CompanyDetail>((resolve) => pending.set(companyId, resolve)),
  );
  return pending;
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockImplementation((url: string) => {
    nav.params = new URLSearchParams(url.split("?")[1] ?? "");
  });
  q.getCompanies.mockResolvedValue([summary(1, "Acme"), summary(2, "Globex")]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("outreach company detail race (CAR-190)", () => {
  it("a slower earlier company's people never overwrite the newer company's", async () => {
    const pending = deferredDetails();
    const view = render(<OutreachPage />);

    // Company A's request goes out and stays in flight — this is the one that
    // must lose. getCompanyDetail runs three waves scaling with employee count,
    // so a big first company genuinely does resolve after a small second one.
    await waitFor(() => expect(pending.has(1)).toBe(true));

    // Navigate to company B before A has answered. The page re-reads
    // searchParams on render, so the mocked replace() is followed by a rerender.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Next company (→)"));
    });
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
    await waitFor(() => expect(pending.has(2)).toBe(true));

    // B answers first...
    await act(async () => pending.get(2)!(detail(2, "Globex", "Bob")));
    await waitFor(() => expect(screen.getByText("Bob")).toBeTruthy());

    // ...then A's slower response lands. It must not commit: A's person under
    // B's header is the bug, and clicking it composed to the wrong company.
    await act(async () => pending.get(1)!(detail(1, "Acme", "Alice")));

    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("clears the previous company's people while the new company loads", async () => {
    const pending = deferredDetails();
    const view = render(<OutreachPage />);

    await waitFor(() => expect(pending.has(1)).toBe(true));
    await act(async () => pending.get(1)!(detail(1, "Acme", "Alice")));
    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTitle("Next company (→)"));
    });
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
    await waitFor(() => expect(pending.has(2)).toBe(true));

    // Mid-flight, with B's header already on screen: Alice must be gone. The
    // gate is `detailLoading && !detail`, so a retained `detail` rendered the
    // old people for the whole fetch on every navigation after the first.
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Loading people…")).toBeTruthy();
  });
});
