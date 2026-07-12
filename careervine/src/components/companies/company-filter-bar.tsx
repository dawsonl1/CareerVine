"use client";

import { useState } from "react";
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
import { Check, ChevronDown, GraduationCap, SlidersHorizontal } from "lucide-react";

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

// One pill system for every toggle, so nothing reads louder than the rest.
// Selected chips share a single soft-green treatment — the label + count tell
// them apart, not five different fills.
const CHIP_BASE =
  "inline-flex items-center h-9 px-3.5 rounded-full text-sm font-medium cursor-pointer border transition-colors duration-200";
const CHIP_OFF = "bg-transparent text-on-surface-variant border-outline-variant hover:bg-surface-container";
const CHIP_ON = "bg-primary-container text-on-primary-container border-transparent";
const SELECT_TRIGGER = "!h-9 !rounded-full !border-outline-variant";

interface CompanyFilterBarProps {
  /** Current filter state with `q` reflecting the live input. */
  filters: CompanyFilters;
  onFiltersChange: (filters: CompanyFilters) => void;
  /** Distinct tier labels present in the loaded data. */
  tierOptions: string[];
  /** Per-status company counts (unfiltered), for chip labels. */
  statusCounts: Record<TargetStatus, number>;
}

/** How many of the secondary (non-stage) filters are active — drives the badge. */
function secondaryActiveCount(f: CompanyFilters): number {
  return (f.productAlum ? 1 : 0) + (f.traction ? 1 : 0) + (f.tier ? 1 : 0) + (f.contacts !== "any" ? 1 : 0);
}

// Checkmark slides open/closed so the label doesn't jump (contacts-page pattern).
function ChipCheck({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`overflow-hidden transition-all duration-200 ease-out ${on ? "w-4 mr-1.5 opacity-100" : "w-0 mr-0 opacity-0"}`}
    >
      <Check className="h-4 w-4" />
    </span>
  );
}

export default function CompanyFilterBar({
  filters,
  onFiltersChange,
  tierOptions,
  statusCounts,
}: CompanyFilterBarProps) {
  const secondaryCount = secondaryActiveCount(filters);
  // Open the secondary drawer on load only if something in it is already active.
  const [open, setOpen] = useState(() => secondaryCount > 0);

  const toggleStatus = (s: TargetStatus) => {
    const statuses = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onFiltersChange({ ...filters, statuses });
  };

  return (
    <div className="mb-6 space-y-3">
      {/* Primary tier: pipeline stages */}
      <div className="flex flex-wrap items-center gap-2">
        {TARGET_STATUSES.map((s) => {
          const on = filters.statuses.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              aria-pressed={on}
              className={`${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF}`}
            >
              <ChipCheck on={on} />
              {STATUS_LABELS[s]}
              <span className="ml-1.5 opacity-60">{statusCounts[s]}</span>
            </button>
          );
        })}

        {/* Secondary tier lives behind this toggle, so stages stay the headline. */}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`${CHIP_BASE} ml-auto gap-1.5 ${
            open || secondaryCount > 0 ? "bg-primary/5 text-primary border-primary/40" : CHIP_OFF
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {secondaryCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-xs">
              {secondaryCount}
            </span>
          )}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Secondary tier: warmth + traction/tier/contacts, collapsed by default */}
      {open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-3">
          <button
            onClick={() => onFiltersChange({ ...filters, productAlum: !filters.productAlum })}
            aria-pressed={filters.productAlum}
            className={`${CHIP_BASE} ${filters.productAlum ? CHIP_ON : CHIP_OFF}`}
          >
            <ChipCheck on={filters.productAlum} />
            <GraduationCap className="h-4 w-4 mr-1.5" />
            BYU alum in product
          </button>

          <Select
            value={filters.traction ?? ""}
            onChange={(v) => onFiltersChange({ ...filters, traction: (v || null) as OutreachStage | null })}
            options={[{ value: "", label: "Any traction" }, ...STAGE_ORDER.map((s) => ({ value: s, label: STAGE_LABELS[s] }))]}
            className="text-sm"
            triggerClassName={SELECT_TRIGGER}
          />

          {tierOptions.length >= 2 && (
            <Select
              value={filters.tier ?? ""}
              onChange={(v) => onFiltersChange({ ...filters, tier: v || null })}
              options={[{ value: "", label: "Any tier" }, ...tierOptions.map((t) => ({ value: t, label: t }))]}
              className="text-sm"
              triggerClassName={SELECT_TRIGGER}
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
            className="text-sm"
            triggerClassName={SELECT_TRIGGER}
          />

          {hasActiveCompanyFilters(filters) && (
            <button
              onClick={() => onFiltersChange(EMPTY_COMPANY_FILTERS)}
              className="h-9 px-3 rounded-full text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
