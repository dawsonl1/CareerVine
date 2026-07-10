"use client";

import { Select } from "@/components/ui/select";
import {
  EMPTY_COMPANY_FILTERS,
  hasActiveCompanyFilters,
  TARGET_STATUSES,
  type CompanyFilters,
  type ContactsFilter,
  type TargetStatus,
} from "@/lib/company-filters";
import { STAGE_LABELS, STAGE_ORDER, type OutreachStage } from "@/lib/stage-derivation";
import { Check, Search, X } from "lucide-react";

// Shared with the company cards on the page.
export const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  outreach_active: "Outreach active",
  applied: "Applied",
  interviewing: "Interviewing",
  closed: "Closed",
};

export const STATUS_STYLES: Record<string, string> = {
  researching: "bg-surface-container-high text-on-surface-variant",
  outreach_active: "bg-primary-container text-on-primary-container",
  applied: "bg-tertiary-container text-on-tertiary-container",
  interviewing: "bg-secondary-container text-on-secondary-container",
  closed: "bg-surface-container text-on-surface-variant line-through",
};

interface CompanyFilterBarProps {
  view: "targets" | "all";
  /** Live search box value (undebounced echo of filters.q). */
  searchInput: string;
  onSearchChange: (value: string) => void;
  /** Current filter state with `q` reflecting the live input. */
  filters: CompanyFilters;
  onFiltersChange: (filters: CompanyFilters) => void;
  /** Distinct tier labels present in the loaded data. */
  tierOptions: string[];
  /** Per-status company counts (unfiltered), for chip labels. */
  statusCounts: Record<TargetStatus, number>;
}

export default function CompanyFilterBar({
  view,
  searchInput,
  onSearchChange,
  filters,
  onFiltersChange,
  tierOptions,
  statusCounts,
}: CompanyFilterBarProps) {
  const toggleStatus = (s: TargetStatus) => {
    const statuses = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onFiltersChange({ ...filters, statuses });
  };

  return (
    <div className="mb-6 space-y-3">
      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search companies…"
          className="w-full h-11 pl-10 pr-10 rounded-full bg-surface-container-high text-on-surface text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
        {searchInput && (
          <button
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-highest transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Facets — target metadata only exists in the targets view */}
      {view === "targets" && (
        <div className="flex flex-wrap items-center gap-2">
          {TARGET_STATUSES.map((s) => {
            const on = filters.statuses.includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                aria-pressed={on}
                className={`inline-flex items-center h-9 px-3.5 rounded-full text-sm font-medium cursor-pointer border transition-colors duration-200 ${
                  on
                    ? `${STATUS_STYLES[s]} border-transparent`
                    : "bg-transparent text-on-surface-variant border-outline-variant hover:bg-surface-container"
                }`}
              >
                {/* Check slides open/closed so the label doesn't jump (contacts-page pattern) */}
                <span
                  aria-hidden
                  className={`overflow-hidden transition-all duration-200 ease-out ${
                    on ? "w-4 mr-1.5 opacity-100" : "w-0 mr-0 opacity-0"
                  }`}
                >
                  <Check className="h-4 w-4" />
                </span>
                {STATUS_LABELS[s]}
                <span className="ml-1.5 opacity-60">{statusCounts[s]}</span>
              </button>
            );
          })}

          <Select
            value={filters.traction ?? ""}
            onChange={(v) => onFiltersChange({ ...filters, traction: (v || null) as OutreachStage | null })}
            options={[
              { value: "", label: "Any traction" },
              ...STAGE_ORDER.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
            ]}
            className="!h-9 text-sm"
          />

          {tierOptions.length >= 2 && (
            <Select
              value={filters.tier ?? ""}
              onChange={(v) => onFiltersChange({ ...filters, tier: v || null })}
              options={[
                { value: "", label: "Any tier" },
                ...tierOptions.map((t) => ({ value: t, label: t })),
              ]}
              className="!h-9 text-sm"
            />
          )}

          <Select
            value={filters.contacts}
            onChange={(v) => onFiltersChange({ ...filters, contacts: v as ContactsFilter })}
            options={[
              { value: "any", label: "Any contacts" },
              { value: "with", label: "With contacts" },
              { value: "none", label: "No contacts yet" },
            ]}
            className="!h-9 text-sm"
          />

          {hasActiveCompanyFilters(filters) && (
            <button
              onClick={() => onFiltersChange(EMPTY_COMPANY_FILTERS)}
              className="h-9 px-3 rounded-full text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
