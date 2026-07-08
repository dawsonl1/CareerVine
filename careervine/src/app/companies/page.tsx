"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { getCompanies, type CompanySummary, type CompanySort } from "@/lib/company-queries";
import { STAGE_LABELS } from "@/lib/stage-derivation";
import { Building2, Search, ExternalLink, CalendarClock, Users, Send } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  outreach_active: "Outreach active",
  applied: "Applied",
  interviewing: "Interviewing",
  closed: "Closed",
};

const STATUS_STYLES: Record<string, string> = {
  researching: "bg-surface-container-high text-on-surface-variant",
  outreach_active: "bg-primary-container text-on-primary-container",
  applied: "bg-tertiary-container text-on-tertiary-container",
  interviewing: "bg-secondary-container text-on-secondary-container",
  closed: "bg-surface-container text-on-surface-variant line-through",
};

function formatDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function CompaniesPage() {
  const { user } = useAuth();
  const [view, setView] = useState<"targets" | "all">("targets");
  const [sort, setSort] = useState<CompanySort>("priority");
  const [search, setSearch] = useState("");
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await getCompanies(user.id, {
        targetsOnly: view === "targets",
        sort,
        // All-companies view is search-driven: full-history import creates
        // thousands of past-employer rows — an unfiltered list is a landfill.
        search: view === "all" ? search : undefined,
        minContacts: 1,
      });
      setCompanies(data);
    } finally {
      setLoading(false);
    }
  }, [user, view, sort, search]);

  useEffect(() => {
    const t = setTimeout(load, view === "all" && search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, view, search]);

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

        {/* Search (all view) */}
        {view === "all" && (
          <div className="relative mb-6 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies…"
              className="w-full h-11 pl-10 pr-4 rounded-full bg-surface-container-high text-on-surface text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="text-on-surface-variant text-sm py-16 text-center">Loading companies…</div>
        ) : companies.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-on-surface-variant text-sm">
              {view === "targets"
                ? "No target companies yet. They arrive with the pipeline import, or add one from a company page."
                : search
                  ? "No companies match that search."
                  : "Type to search across every company in your network history."}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {companies.map((c) => (
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
    </div>
  );
}
