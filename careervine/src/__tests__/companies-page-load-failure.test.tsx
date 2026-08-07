// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { resetListCache } from "@/lib/list-cache";
import type { CompanySummary } from "@/lib/company-queries";

/**
 * CAR-205, finding 6a. `load()` caught into `console.error` and left `companies`
 * at `[]`, which the list render reads as the load-empty case:
 *
 *   "No companies yet. Target a company or import your network to get started."
 *
 * ...beside an "Add a company" button. That is not a hidden error, it is a
 * confident claim about the user's data plus an invitation to act on it, over a
 * read that never succeeded. CONVENTIONS §f names this exact shape.
 */

const q = vi.hoisted(() => ({ getCompanies: vi.fn() }));

vi.mock("@/lib/company-queries", () => ({ getCompanies: q.getCompanies }));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/companies",
}));

import CompaniesPage from "@/app/companies/page";

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
    traction_detail: null,
  };
}

const EMPTY_COPY = /No companies yet/;

// The list cache is module state, so it outlives a test the same way it
// outlives a route change (CAR-256). Without this reset the "Retry" case leaves
// Acme cached under the same key and the genuinely-empty case below reads it
// back instead of calling getCompanies at all.
beforeEach(() => {
  vi.clearAllMocks();
  resetListCache();
});
afterEach(cleanup);

describe("companies page load failure", () => {
  it("renders the retryable error state, never the load-empty copy", async () => {
    q.getCompanies.mockRejectedValue(new Error("boom"));
    render(<CompaniesPage />);

    await waitFor(() => expect(screen.getByText("Couldn't load your companies.")).toBeTruthy());
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it("recovers on Retry", async () => {
    q.getCompanies.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([summary(1, "Acme")]);
    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Couldn't load your companies.")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    expect(screen.queryByText("Couldn't load your companies.")).toBeNull();
  });

  it("still shows the empty copy when the read genuinely returns nothing", async () => {
    // The companion. "Never show the empty state" is trivially satisfiable by
    // never showing it at all, and the empty state is correct and useful when
    // the read actually succeeded.
    q.getCompanies.mockResolvedValue([]);
    render(<CompaniesPage />);

    await waitFor(() => expect(screen.getByText(EMPTY_COPY)).toBeTruthy());
    expect(screen.queryByText("Couldn't load your companies.")).toBeNull();
  });
});
