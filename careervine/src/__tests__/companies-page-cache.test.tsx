// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { resetListCache } from "@/lib/list-cache";
import { invalidateCompaniesList } from "@/lib/companies-list-cache";
import type { CompanySummary } from "@/lib/company-queries";

/**
 * CAR-256. Going into a company and back re-ran the whole four-wave read, so
 * the user waited again for rows they had already waited for once.
 *
 * The load-bearing assertion is not "the rows come back" — a refetch does that
 * too, slowly. It is that `getCompanies` is NOT CALLED, and that the rows are
 * present synchronously, with no "Loading companies…" in between. A cache that
 * paints one render late is a cache that scroll restoration cannot use, because
 * the document is still one viewport tall when the browser restores.
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

/** The user id `mockAuthProviderModule` signs in as. */
const USER_ID = "u-1";

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
    lead_name: null,
    next_action: null,
    target: { status: "researching" } as CompanySummary["target"],
    office_scopes: [],
    traction: null,
    traction_detail: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetListCache();
});
afterEach(cleanup);

describe("companies list cache", () => {
  it("serves a remount from cache without refetching, and without a loading flash", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);

    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    expect(q.getCompanies).toHaveBeenCalledTimes(1);

    // The trip into a company and back: this page unmounts, then mounts again.
    first.unmount();
    render(<CompaniesPage />);

    // No `waitFor`. The row is on the first painted commit or the assertion
    // fails, which is exactly the property scroll restoration depends on.
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByText("Loading companies…")).toBeNull();
    expect(q.getCompanies).toHaveBeenCalledTimes(1);
  });

  it("refetches after a write invalidates the list", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    // What the detail page does after a pipeline save or a tier move: the row
    // it just changed must not come back from cache contradicting the write.
    q.getCompanies.mockResolvedValue([summary(1, "Acme"), summary(2, "Globex")]);
    invalidateCompaniesList(USER_ID);

    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Globex")).toBeTruthy());
    expect(q.getCompanies).toHaveBeenCalledTimes(2);
  });

  it("scopes invalidation to the user who did the writing", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    invalidateCompaniesList("someone-else");

    render(<CompaniesPage />);
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(q.getCompanies).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read", async () => {
    q.getCompanies.mockRejectedValueOnce(new Error("boom"));
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Couldn't load your companies.")).toBeTruthy());
    first.unmount();

    // A cached failure would strand the user on the error state for the whole
    // TTL with no way back except a hard refresh.
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    expect(q.getCompanies).toHaveBeenCalledTimes(2);
  });
});
