"use client";

import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import CompanyFilterBar from "@/components/companies/company-filter-bar";
import { CompanyCard } from "@/components/companies/company-card";
import { AddCompanyModal } from "@/components/companies/add-company-modal";
import { getCompanies, type CompanySummary, type CompanySort } from "@/lib/company-queries";
import {
  EMPTY_COMPANY_FILTERS,
  countByStatus,
  distinctTiers,
  filterCompanies,
  hasActiveCompanyFilters,
  parseCompanyFilters,
  serializeCompanyFilters,
  type CompanyFilters,
} from "@/lib/company-filters";
import { Building2, Send, Plus, Search, X } from "lucide-react";

const VALID_SORTS: readonly CompanySort[] = ["next", "priority", "next_app_date", "traction", "name"];

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
  const searchParams = useSearchParams();

  // URL is the source of truth for sort/search/filters so state survives
  // back-navigation from a company detail page and links are shareable.
  const rawSort = searchParams.get("sort") as CompanySort | null;
  const sort: CompanySort = rawSort && VALID_SORTS.includes(rawSort) ? rawSort : "next";
  const urlFilters = useMemo(() => parseCompanyFilters(searchParams), [searchParams]);

  // Local echo of the search box so typing stays instant; synced to the URL
  // on a debounce below.
  const [searchInput, setSearchInput] = useState(urlFilters.q);
  const lastWrittenQ = useRef(urlFilters.q);

  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddCompany, setShowAddCompany] = useState(false);

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.replace(qs ? `/companies?${qs}` : "/companies", { scroll: false });
    },
    [router],
  );

  // External URL changes (back/forward, shared links) → sync the input.
  // Our own debounced writes update lastWrittenQ first, so they don't
  // clobber newer keystrokes when the URL catches up.
  useEffect(() => {
    if (urlFilters.q !== lastWrittenQ.current) {
      setSearchInput(urlFilters.q);
      lastWrittenQ.current = urlFilters.q;
    }
  }, [urlFilters.q]);

  // Debounced input → URL so search state is shareable and survives back-nav
  useEffect(() => {
    if (searchInput === urlFilters.q) return;
    const t = setTimeout(() => {
      lastWrittenQ.current = searchInput;
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
      lastWrittenQ.current = f.q;
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
  const tierOptions = useMemo(() => distinctTiers(companies), [companies]);
  const statusCounts = useMemo(() => countByStatus(companies), [companies]);
  const filtersActive = hasActiveCompanyFilters(liveFilters);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // One list: every company you're targeting or already know someone at.
      const data = await getCompanies(user.id, { scope: "in_play", sort, minContacts: 1 });
      setCompanies(data);
    } catch (e) {
      console.error("Error loading companies:", e);
    } finally {
      setLoading(false);
    }
  }, [user, sort]);

  useEffect(() => {
    // load() reports its own failures, so the effect can fire and forget
    void load();
  }, [load]);

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

        {/* Stage + facet filters — toggle stages to focus the list */}
        <CompanyFilterBar
          filters={liveFilters}
          onFiltersChange={setFilters}
          tierOptions={tierOptions}
          statusCounts={statusCounts}
        />

        {/* Result count — only when filtering, so the default view stays quiet */}
        {!loading && filtersActive && companies.length > 0 && (
          <p className="text-xs text-on-surface-variant mb-3">
            {visible.length} of {companies.length} companies
          </p>
        )}

        {/* List */}
        {loading ? (
          <div className="text-on-surface-variant text-sm py-16 text-center">Loading companies…</div>
        ) : visible.length === 0 ? (
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
              <CompanyCard key={c.id} company={c} />
            ))}
          </div>
        )}
      </main>

      {showAddCompany && user && <AddCompanyModal userId={user.id} onClose={() => setShowAddCompany(false)} />}
    </div>
  );
}
