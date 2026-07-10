/**
 * Location-scope data for the company page (CAR-6).
 *
 * Builds the scope blocks the pipeline layout renders: "All" (full
 * roster + company-wide recruiting scope) plus one block per office.
 * Office targeting/status come from real target_companies scope rows
 * (location_id = office); the company-wide row is location_id NULL.
 * Replaces the preview-era company-location-preview module, which
 * fabricated office targeting for layout demos.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import {
  getCompanyDetail,
  type CompanyDetail,
  type CompanyNote,
  type CompanyPerson,
  type LocationFacet,
} from "@/lib/company-queries";
import { formatOfficeTabLabel } from "@/lib/location-tab-label";

export interface LocationBlock {
  key: string;
  label: string;
  /** Compact tab label: "Dallas, TX" or "London, United Kingdom" */
  tabLabel: string;
  location_id: number | null;
  contactCount: number;
  isTargeted: boolean;
  status: string | null;
  next_app_date: string | null;
  app_window_text: string | null;
  notes: CompanyNote[];
  current: CompanyPerson[];
  former: CompanyPerson[];
  bench: CompanyPerson[];
}

export interface LocationTabsData {
  all: LocationBlock;
  /** Company-wide recruiting scope (general application, notes, status) — independent of offices */
  companyWide: LocationBlock | null;
  offices: LocationBlock[];
  /** Remote / Unknown — not offices; shown under All view only */
  unassigned: LocationBlock[];
}

function countPeople(current: CompanyPerson[], former: CompanyPerson[]) {
  return new Set([...current, ...former].map((p) => p.contact_id)).size;
}

function facetTabLabel(facet: LocationFacet): string {
  if (facet.key === "remote") return "Remote";
  if (facet.key === "unknown") return "Unknown";
  return formatOfficeTabLabel(facet.city, facet.state, facet.country);
}

function notesForLocation(allNotes: CompanyNote[], facet: LocationFacet): CompanyNote[] {
  return allNotes.filter((n) => {
    if (facet.key === "remote" || facet.key === "unknown") return false;
    return n.location_id != null && String(n.location_id) === facet.key;
  });
}

function isOfficeFacetKey(key: string): boolean {
  return key !== "remote" && key !== "unknown";
}

interface OfficeScopeRow {
  location_id: number | null;
  is_targeted: boolean;
  status: string;
  next_app_date: string | null;
  app_window_text: string | null;
}

/** Office-scoped target rows (location_id set), keyed by String(location_id). */
async function fetchOfficeScopes(
  userId: string,
  companyId: number,
): Promise<Map<string, OfficeScopeRow>> {
  const { data, error } = await createSupabaseBrowserClient()
    .from("target_companies")
    .select("location_id, is_targeted, status, next_app_date, app_window_text")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .not("location_id", "is", null);
  if (error) throw error;
  const map = new Map<string, OfficeScopeRow>();
  for (const row of (data ?? []) as OfficeScopeRow[]) {
    map.set(String(row.location_id), row);
  }
  return map;
}

export async function fetchCompanyScopes(
  userId: string,
  companyId: number,
): Promise<{
  company: CompanyDetail["company"];
  tabs: LocationTabsData;
  totalContacts: number;
  target: CompanyDetail["target"];
  offices: CompanyDetail["offices"];
}> {
  const [base, officeScopes] = await Promise.all([
    getCompanyDetail(userId, companyId),
    fetchOfficeScopes(userId, companyId),
  ]);
  if (!base) throw new Error("Company not found");

  const allNotes = base.target?.notes ?? [];

  const facetDetails = await Promise.all(
    base.facets.map((facet) => getCompanyDetail(userId, companyId, { locationKey: facet.key })),
  );

  const offices: LocationBlock[] = [];
  const unassigned: LocationBlock[] = [];

  base.facets.forEach((facet, index) => {
    const scoped = facetDetails[index];
    if (!scoped) return;

    const isOffice = isOfficeFacetKey(facet.key);
    const scopeRow = isOffice ? officeScopes.get(facet.key) : undefined;

    const block: LocationBlock = {
      key: facet.key,
      label: facet.label,
      tabLabel: facetTabLabel(facet),
      location_id: facet.location_id,
      contactCount: facet.count,
      isTargeted: Boolean(scopeRow?.is_targeted),
      status: scopeRow?.is_targeted ? scopeRow.status : null,
      next_app_date: scopeRow?.next_app_date ?? null,
      app_window_text: scopeRow?.app_window_text ?? null,
      notes: notesForLocation(allNotes, facet),
      current: scoped.current,
      former: scoped.former,
      bench: scoped.bench,
    };

    if (isOffice) offices.push(block);
    else unassigned.push(block);
  });

  offices.sort((a, b) => b.contactCount - a.contactCount || a.label.localeCompare(b.label));

  const totalContacts = countPeople(base.current, base.former);
  const companyWideNotes = allNotes.filter((n) => n.location_id == null);

  const companyWide: LocationBlock | null = base.target
    ? {
        key: "company",
        label: "Company-wide",
        tabLabel: "Company",
        location_id: null,
        contactCount: 0,
        isTargeted: true,
        status: base.target.status,
        next_app_date: base.target.next_app_date,
        app_window_text: base.target.app_window_text,
        notes: companyWideNotes,
        current: [],
        former: [],
        bench: [],
      }
    : null;

  const all: LocationBlock = {
    key: "all",
    label: "All contacts",
    tabLabel: "All",
    location_id: null,
    contactCount: totalContacts,
    isTargeted: false,
    status: null,
    next_app_date: null,
    app_window_text: null,
    notes: allNotes,
    current: base.current,
    former: base.former,
    bench: base.bench,
  };

  return {
    company: base.company,
    tabs: { all, companyWide, offices, unassigned },
    totalContacts,
    target: base.target,
    offices: base.offices,
  };
}
