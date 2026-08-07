// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { resetListCache, readList, writeList } from "@/lib/list-cache";
import {
  refreshCompaniesList,
  companiesListKey,
  COMPANIES_LIST_TTL_MS,
} from "@/lib/companies-list-cache";
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
    lead_contact_name: null,
    target: { status: "researching" } as CompanySummary["target"],
    office_scopes: [],
    offices: [],
    roster: [],
    traction: null,
    traction_detail: null,
    lead_detail: null,
    conversation: null,
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

  it("shows the written row, never the cached one it contradicts", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    // What the detail page does after a pipeline save or a tier move: the row
    // it just changed must not come back from cache contradicting the write.
    q.getCompanies.mockResolvedValue([summary(1, "Acme"), summary(2, "Globex")]);
    refreshCompaniesList(USER_ID);

    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Globex")).toBeTruthy());
    // Two, not three: the refresh's fetch is JOINED, not duplicated (CAR-278).
    expect(q.getCompanies).toHaveBeenCalledTimes(2);
  });

  it("comes back warm when the refresh landed before the user did (CAR-278)", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    // The user changes something and stays on the detail page long enough for
    // the background refetch to finish. This is the whole feature: the write
    // used to leave the cache empty, so the return trip paid for a full read.
    q.getCompanies.mockResolvedValue([summary(1, "Acme"), summary(2, "Globex")]);
    refreshCompaniesList(USER_ID);
    await waitFor(() => expect(q.getCompanies).toHaveBeenCalledTimes(2));

    render(<CompaniesPage />);
    // Synchronous, like the first test: a warm cache means no loading flash and
    // a document already at full height for scroll restoration.
    expect(screen.getByText("Globex")).toBeTruthy();
    expect(screen.queryByText("Loading companies…")).toBeNull();
    expect(q.getCompanies).toHaveBeenCalledTimes(2);
  });

  it("scopes the refresh to the user who did the writing", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    refreshCompaniesList("someone-else");

    render(<CompaniesPage />);
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(q.getCompanies).toHaveBeenCalledTimes(1);
  });

  it("leaves the cache empty when the background refresh fails", async () => {
    q.getCompanies.mockResolvedValue([summary(1, "Acme")]);
    const first = render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    first.unmount();

    // A refresh nobody asked for must not strand the page on stale rows or
    // surface an error: it degrades to an ordinary miss.
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    q.getCompanies.mockRejectedValueOnce(new Error("network"));
    refreshCompaniesList(USER_ID);
    await waitFor(() => expect(q.getCompanies).toHaveBeenCalledTimes(2));

    q.getCompanies.mockResolvedValue([summary(2, "Globex")]);
    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText("Globex")).toBeTruthy());
    expect(q.getCompanies).toHaveBeenCalledTimes(3);
    console_.mockRestore();
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

/**
 * CAR-278 widened this window from five minutes to fifteen. Stated as the trips
 * it does and does not cover rather than as the digits, because the digits are
 * not the claim: what the ticket decided is that a long detour through a company
 * should still come back to a cached list, and that the window is still a bound
 * rather than forever. Every write CareerVine itself makes refreshes the cache
 * at the write site, so this governs only what the tab cannot see (a cron, MCP,
 * another tab).
 */
describe("companies list TTL", () => {
  const MINUTE = 60 * 1000;
  const KEY = companiesListKey(USER_ID, "next");
  const ROWS = [summary(1, "Acme")];

  it("still serves the list after a ten-minute detour", () => {
    writeList(KEY, ROWS, 0);
    expect(readList(KEY, COMPANIES_LIST_TTL_MS, 10 * MINUTE)).toEqual(ROWS);
  });

  it("has let go by twenty minutes, so the blind window stays bounded", () => {
    writeList(KEY, ROWS, 0);
    expect(readList(KEY, COMPANIES_LIST_TTL_MS, 20 * MINUTE)).toBeUndefined();
  });
});
