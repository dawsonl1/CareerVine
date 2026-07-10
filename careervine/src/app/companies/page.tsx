"use client";

import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import CompanyFilterBar, { STATUS_LABELS, STATUS_STYLES } from "@/components/companies/company-filter-bar";
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
import { STAGE_LABELS } from "@/lib/stage-derivation";
import { Building2, ExternalLink, CalendarClock, Users, Send, Plus, MapPin } from "lucide-react";

const VALID_SORTS: readonly CompanySort[] = ["priority", "next_app_date", "traction", "name"];

function formatDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

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

  // URL is the source of truth for view/sort/search so state survives
  // back-navigation from a company detail page and links are shareable.
  const view: "targets" | "all" = searchParams.get("view") === "all" ? "all" : "targets";
  const rawSort = searchParams.get("sort") as CompanySort | null;
  const sort: CompanySort = rawSort && VALID_SORTS.includes(rawSort) ? rawSort : "priority";
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

  // Debounced input → URL (also drives the server-side search in "all" view)
  useEffect(() => {
    if (searchInput === urlFilters.q) return;
    const t = setTimeout(() => {
      lastWrittenQ.current = searchInput;
      replaceParams(serializeCompanyFilters({ ...urlFilters, q: searchInput }, searchParams));
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, urlFilters, searchParams, replaceParams]);

  const setView = (v: "targets" | "all") => {
    const p = new URLSearchParams(searchParams.toString());
    if (v === "all") p.set("view", "all");
    else p.delete("view");
    replaceParams(p);
  };

  const setSort = (s: CompanySort) => {
    const p = new URLSearchParams(searchParams.toString());
    if (s === "priority") p.delete("sort");
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

  // Targets view filters client-side: the full aggregate is already in
  // memory, so filtering is a pure pass — no refetch per keystroke.
  const deferredQ = useDeferredValue(searchInput);
  const visible = useMemo(
    () => (view === "targets" ? filterCompanies(companies, { ...urlFilters, q: deferredQ }) : companies),
    [view, companies, urlFilters, deferredQ],
  );
  const tierOptions = useMemo(() => distinctTiers(companies), [companies]);
  const statusCounts = useMemo(() => countByStatus(companies), [companies]);
  const filtersActive = hasActiveCompanyFilters(liveFilters);

  // All-companies view is search-driven: full-history import creates
  // thousands of past-employer rows — an unfiltered list is a landfill.
  const serverSearch = view === "all" ? urlFilters.q : undefined;

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await getCompanies(user.id, {
        targetsOnly: view === "targets",
        sort,
        search: serverSearch,
        minContacts: 1,
      });
      setCompanies(data);
    } finally {
      setLoading(false);
    }
  }, [user, view, sort, serverSearch]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-on-surface flex items-center gap-2.5">
              <Building2 className="w-6 h-6 text-primary" /> Companies
            </h1>
            <p className="text-sm text-on-surface-variant mt-1">
              {view === "targets" ? "Your target companies and the people you know inside them" : "Every company in your network history"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={() => setShowAddCompany(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Add company
            </Button>
            <Link href="/outreach">
              <Button size="sm">
                <Send className="w-4 h-4 mr-1.5" /> Start outreach flow
              </Button>
            </Link>
            {/* Targets / All toggle */}
            <div className="flex rounded-full bg-surface-container-high p-1">
              {(["targets", "all"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    view === v ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {v === "targets" ? "Targets" : "All"}
                </button>
              ))}
            </div>
            {view === "targets" && (
              <Select
                value={sort}
                onChange={(v) => setSort(v as CompanySort)}
                options={[
                  { value: "priority", label: "Sort: Priority" },
                  { value: "next_app_date", label: "Sort: Next app date" },
                  { value: "traction", label: "Sort: Traction" },
                  { value: "name", label: "Sort: Name" },
                ]}
                className="!h-10 text-sm"
              />
            )}
          </div>
        </div>

        {/* Search + filters */}
        <CompanyFilterBar
          view={view}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          filters={liveFilters}
          onFiltersChange={setFilters}
          tierOptions={tierOptions}
          statusCounts={statusCounts}
        />

        {/* Result count — only when filtering, so the default view stays quiet */}
        {!loading && view === "targets" && filtersActive && companies.length > 0 && (
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
              {view === "targets" && companies.length > 0 ? (
                <span className="inline-flex items-center gap-3">
                  No companies match these filters.
                  <button onClick={() => setFilters(EMPTY_COMPANY_FILTERS)} className="text-primary font-medium hover:underline">
                    Clear filters
                  </button>
                </span>
              ) : view === "targets" ? (
                <span className="inline-flex items-center gap-3">
                  No target companies yet.
                  <button onClick={() => setShowAddCompany(true)} className="text-primary font-medium hover:underline">
                    Add a company
                  </button>
                </span>
              ) : urlFilters.q ? (
                "No companies match that search."
              ) : (
                "Type to search across every company in your network history."
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {visible.map((c) => (
              <Link key={c.id} href={`/companies/${c.id}`} className="block group">
                <Card className="transition-shadow group-hover:shadow-md">
                  <CardContent className="py-4 px-5">
                    <div className="flex items-center gap-4">
                      {/* Logo / initial */}
                      <div className="w-11 h-11 rounded-xl bg-surface-container-high flex items-center justify-center overflow-hidden shrink-0">
                        {c.logo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.logo_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-lg font-semibold text-on-surface-variant">{c.name.charAt(0)}</span>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-on-surface truncate">{c.name}</span>
                          {c.target && (
                            <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[c.target.status] ?? STATUS_STYLES.researching}`}>
                              {STATUS_LABELS[c.target.status] ?? c.target.status}
                            </span>
                          )}
                          {c.target?.tier && (
                            <span className="px-2.5 py-0.5 rounded-full text-xs bg-surface-container-high text-on-surface-variant">{c.target.tier}</span>
                          )}
                          {c.traction && c.traction !== "not_contacted" && (
                            <span className="px-2.5 py-0.5 rounded-full text-xs bg-tertiary-container text-on-tertiary-container">
                              {STAGE_LABELS[c.traction]}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-on-surface-variant flex-wrap">
                          <span className="flex items-center gap-1">
                            <Users className="w-3.5 h-3.5" />
                            {c.current_count + c.former_count} contact{c.current_count + c.former_count === 1 ? "" : "s"}
                            {c.bench_count > 0 && <span className="opacity-70"> · {c.bench_count} bench</span>}
                          </span>
                          {c.target?.program_name && <span className="truncate">{c.target.program_name}</span>}
                          {c.target?.next_app_date ? (
                            <span className="flex items-center gap-1 text-primary font-medium">
                              <CalendarClock className="w-3.5 h-3.5" /> Apps: {formatDate(c.target.next_app_date)}
                            </span>
                          ) : c.target?.app_window_text ? (
                            <span className="italic opacity-80 truncate max-w-64" title={c.target.app_window_text}>
                              {c.target.app_window_text}
                            </span>
                          ) : null}
                        </div>
                        {/* Office scopes — only when location-level targets exist (§21.5) */}
                        {c.office_scopes.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1 text-xs text-on-surface-variant flex-wrap">
                            <MapPin className="w-3.5 h-3.5 shrink-0" />
                            {c.office_scopes.slice(0, 2).map((s, i) => (
                              <span key={s.location_id} className="truncate">
                                {i > 0 && <span className="opacity-60">— </span>}
                                {s.label} · {STATUS_LABELS[s.status] ?? s.status}
                              </span>
                            ))}
                            {c.office_scopes.length > 2 && (
                              <span className="opacity-70">+{c.office_scopes.length - 2} more</span>
                            )}
                          </div>
                        )}
                      </div>

                      {c.target?.priority_score != null && (
                        <div className="text-right shrink-0">
                          <div className="text-lg font-semibold text-on-surface">{c.target.priority_score}</div>
                          <div className="text-[10px] uppercase tracking-wide text-on-surface-variant">priority</div>
                        </div>
                      )}
                      <ExternalLink className="w-4 h-4 text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>

      {showAddCompany && user && <AddCompanyModal userId={user.id} onClose={() => setShowAddCompany(false)} />}
    </div>
  );
}
