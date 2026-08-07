"use client";

import { useState, useEffect, useCallback, useDeferredValue, useMemo, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { LoadErrorBanner, LoadErrorState } from "@/components/ui/load-error-state";
import { useCachedList } from "@/hooks/use-cached-list";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { COMPANIES_LIST_TTL_MS, companiesListKey } from "@/lib/companies-list-cache";
import CompanyFilterBar from "@/components/companies/company-filter-bar";
import {
  locationOptions,
  noLocationCount,
  parseLocationSelection,
} from "@/lib/company-location-filter";
import { CompanyCard } from "@/components/companies/company-card";
import { AddCompanyModal } from "@/components/companies/add-company-modal";
import { getCompanies, type CompanySummary, type CompanySort } from "@/lib/company-queries";
import {
  EMPTY_COMPANY_FILTERS,
  filterCompanies,
  hasActiveCompanyFilters,
  parseCompanyFilters,
  serializeCompanyFilters,
  statusChipCounts,
  type CompanyFilters,
} from "@/lib/company-filters";
import { Building2, Send, Plus, Search, X } from "lucide-react";

const VALID_SORTS: readonly CompanySort[] = ["next", "priority", "next_app_date", "traction", "name"];

// Stable empty list, so the cached-list fallback is not a new array each render.
const NO_COMPANIES: CompanySummary[] = [];

// useSearchParams requires a Suspense boundary (same pattern as settings/page.tsx)
export default function CompaniesPageWrapper() {
  return (
    <Suspense>
      <CompaniesPage />
    </Suspense>
  );
}

function CompaniesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL is the source of truth for sort/search/filters so state survives
  // back-navigation from a company detail page and links are shareable.
  const rawSort = searchParams.get("sort") as CompanySort | null;
  const sort: CompanySort = rawSort && VALID_SORTS.includes(rawSort) ? rawSort : "next";
  const urlFilters = useMemo(() => parseCompanyFilters(searchParams), [searchParams]);

  // Local echo of the search box so typing stays instant; synced to the URL
  // on a debounce below.
  const [searchInput, setSearchInput] = useState(urlFilters.q);
  // State rather than a ref: it is compared during render (below), and a ref
  // may not be read there. Both writers set it before the URL write they are
  // announcing, and React batches each pair into one commit, so it is never
  // observed stale against the URL change it describes.
  const [lastWrittenQ, setLastWrittenQ] = useState(urlFilters.q);

  const [showAddCompany, setShowAddCompany] = useState(false);

  // The list read, cached across the trip into a company and back (CAR-256).
  // Keyed on the user and the SERVER sort, which are the only two inputs
  // getCompanies takes — every filter below is a pure client-side pass over the
  // same rows, so filtering must never invalidate this.
  const fetchCompanies = useCallback(async () => {
    // Unreachable while `key` is null, which is the whole time `user` is null.
    if (!user) return NO_COMPANIES;
    // One list: every company you're targeting or already know someone at.
    return getCompanies(user.id, { scope: "in_play", sort, minContacts: 1 });
  }, [user, sort]);

  const {
    data: companies,
    loading,
    failed: loadFailed,
    fromCache,
    reload,
  } = useCachedList<CompanySummary[]>({
    key: user ? companiesListKey(user.id, sort) : null,
    ttlMs: COMPANIES_LIST_TTL_MS,
    fetcher: fetchCompanies,
    fallback: NO_COMPANIES,
  });

  // Put the user back where they were when they return from a company page.
  // Gated on `fromCache`: only then is the list at full height on this commit,
  // which is the condition the browser's own restoration cannot meet here.
  useScrollRestoration({ pathname, search: searchParams.toString(), ready: fromCache });

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.replace(qs ? `/companies?${qs}` : "/companies", { scroll: false });
    },
    [router],
  );

  // External URL changes (back/forward, shared links) → sync the input.
  // Our own writes record lastWrittenQ first, so they don't clobber newer
  // keystrokes when the URL catches up.
  //
  // Adjusted DURING RENDER rather than in an effect: an effect here commits a
  // render, then immediately schedules another, and React's own guidance (plus
  // `react-hooks/set-state-in-effect`) is to derive the new value in the render
  // that already knows about the change. The comparison is what bounds it — the
  // next render finds the two equal and falls straight through.
  if (urlFilters.q !== lastWrittenQ) {
    setLastWrittenQ(urlFilters.q);
    setSearchInput(urlFilters.q);
  }

  // Debounced input → URL so search state is shareable and survives back-nav
  useEffect(() => {
    if (searchInput === urlFilters.q) return;
    const t = setTimeout(() => {
      setLastWrittenQ(searchInput);
      replaceParams(serializeCompanyFilters({ ...urlFilters, q: searchInput }, searchParams));
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, urlFilters, searchParams, replaceParams]);

  const setSort = (s: CompanySort) => {
    const p = new URLSearchParams(searchParams.toString());
    if (s === "next") p.delete("sort");
    else p.set("sort", s);
    replaceParams(p);
  };

  // Facet changes (chips/selects) write straight to the URL; q comes from
  // the live input so a pending debounce can't be clobbered by stale state.
  const liveFilters = useMemo<CompanyFilters>(
    () => ({ ...urlFilters, q: searchInput }),
    [urlFilters, searchInput],
  );
  const setFilters = useCallback(
    (f: CompanyFilters) => {
      setLastWrittenQ(f.q);
      setSearchInput(f.q);
      replaceParams(serializeCompanyFilters(f, searchParams));
    },
    [replaceParams, searchParams],
  );

  // Everything filters client-side: the full aggregate is already in memory,
  // so search + stage chips + facets are a pure pass, no refetch per keystroke.
  const deferredQ = useDeferredValue(searchInput);
  const visible = useMemo(
    () => filterCompanies(companies, { ...urlFilters, q: deferredQ }),
    [companies, urlFilters, deferredQ],
  );
  // Both computed over the WHOLE list, never `visible` — options that disappear
  // as you filter make the dropdown feel broken.
  const locationGroups = useMemo(() => locationOptions(companies), [companies]);
  const noLocationTotal = useMemo(() => noLocationCount(companies), [companies]);
  // Parsed once here and threaded to the cards, so every card scopes against
  // the same selection the row filter used.
  const locationSelection = useMemo(
    () => parseLocationSelection(liveFilters.locations),
    [liveFilters.locations],
  );
  // Chip counts follow every other facet (CAR-245), so each one predicts its own click.
  const statusCounts = useMemo(
    () => statusChipCounts(companies, { ...urlFilters, q: deferredQ }),
    [companies, urlFilters, deferredQ],
  );
  const filtersActive = hasActiveCompanyFilters(liveFilters);

  // Same load-vs-resync split the outreach page uses (section f). `companies` is
  // never cleared on a throw, so a failed REFRESH still has a valid list to show
  // and gets the inline banner; only a failure with nothing loaded earns the
  // full-region error state. useCachedList preserves that no-clear rule, and its
  // useLatestRequest gate keeps the CAR-205 fix where a stale REJECTION landing
  // after a newer success set `loadFailed` with nothing left to clear it.
  const showingStaleList = loadFailed && companies.length > 0;
  const fullError = loadFailed && companies.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header — title + primary actions */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl font-semibold text-on-surface flex items-center gap-2.5">
              <Building2 className="w-6 h-6 text-primary" /> Companies
            </h1>
            <p className="text-sm text-on-surface-variant mt-1">
              Every company you&apos;re targeting or already know someone at. Filter by stage to focus.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowAddCompany(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Add company
            </Button>
            <Link href="/outreach">
              <Button size="sm">
                <Send className="w-4 h-4 mr-1.5" /> Start outreach flow
              </Button>
            </Link>
          </div>
        </div>

        {/* Control bar — search + sort */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search companies…"
              className="w-full h-10 pl-10 pr-10 rounded-full bg-surface-container-highest text-on-surface text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-on-surface-variant hover:text-on-surface"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <Select
            ariaLabel="Sort companies"
            value={sort}
            onChange={(v) => setSort(v as CompanySort)}
            options={[
              { value: "next", label: "Sort: What's next" },
              { value: "priority", label: "Sort: Priority" },
              { value: "next_app_date", label: "Sort: Next app date" },
              { value: "traction", label: "Sort: Traction" },
              { value: "name", label: "Sort: Name" },
            ]}
            className="text-sm shrink-0"
            triggerClassName="!h-10 !rounded-full !border-outline-variant"
          />
        </div>

        {/* Stage + facet filters — toggle stages to focus the list.
            The chips stay usable as controls while a load has failed with
            nothing loaded, but their COUNTS are suppressed there: countByStatus
            seeds every status to 0, so an unloaded list renders five confident
            zeros directly above "Couldn't load your companies." (CAR-205
            review). Zeroes are the lie, so the counts go, not the bar. */}
        <CompanyFilterBar
          filters={liveFilters}
          onFiltersChange={setFilters}
          locationGroups={locationGroups}
          noLocationCount={noLocationTotal}
          statusCounts={showingStaleList || !loadFailed ? statusCounts : undefined}
        />

        {/* Result count — only when filtering, so the default view stays quiet.
            Also suppressed under a full error state, where `companies` is
            whatever the last successful read left and the count would describe
            data the panel below says could not be loaded. */}
        {!loading && !fullError && filtersActive && companies.length > 0 && (
          <p className="text-xs text-on-surface-variant mb-3">
            {visible.length} of {companies.length} companies
          </p>
        )}

        {/* List */}
        {loading ? (
          <div className="text-on-surface-variant text-sm py-16 text-center">Loading companies…</div>
        ) : fullError ? (
          <LoadErrorState
            message="Couldn't load your companies."
            onRetry={reload}
          />
        ) : (
          <>
            {/* A refresh failed over a list that is still on screen and still
                valid. Keeping it is right; keeping it silently is not. */}
            {showingStaleList && (
              <LoadErrorBanner
                className="mb-3"
                message="Couldn't refresh your companies. Showing what was already loaded."
                onRetry={reload}
              />
            )}
            {visible.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-on-surface-variant text-sm">
              {companies.length > 0 ? (
                <span className="inline-flex items-center gap-3">
                  No companies match these filters.
                  <button onClick={() => setFilters(EMPTY_COMPANY_FILTERS)} className="text-primary font-medium hover:underline">
                    Clear filters
                  </button>
                </span>
              ) : (
                <span className="inline-flex items-center gap-3">
                  No companies yet. Target a company or import your network to get started.
                  <button onClick={() => setShowAddCompany(true)} className="text-primary font-medium hover:underline">
                    Add a company
                  </button>
                </span>
              )}
            </CardContent>
          </Card>
            ) : (
              <div className="grid gap-3">
                {visible.map((c) => (
                  <CompanyCard key={c.id} company={c} locationSelection={locationSelection} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {showAddCompany && user && <AddCompanyModal userId={user.id} onClose={() => setShowAddCompany(false)} />}
    </div>
  );
}
