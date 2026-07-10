import {
  getCompanyDetail,
  type CompanyDetail,
  type CompanyNote,
  type CompanyPerson,
  type LocationFacet,
} from "@/lib/company-queries";
import { formatOfficeTabLabel } from "@/lib/location-tab-label";

export interface PreviewLocationBlock {
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

/** Demo targeting so previews show a mix of expanded / collapsed blocks. */
function mockTargetMeta(
  index: number,
  companyTarget: CompanyDetail["target"],
): Pick<PreviewLocationBlock, "isTargeted" | "status" | "next_app_date" | "app_window_text"> {
  if (index === 0) {
    return {
      isTargeted: true,
      status: "outreach_active",
      next_app_date: "2026-09-15",
      app_window_text: companyTarget?.app_window_text ?? null,
    };
  }
  if (index === 1) {
    return {
      isTargeted: true,
      status: "researching",
      next_app_date: null,
      app_window_text: null,
    };
  }
  return {
    isTargeted: false,
    status: null,
    next_app_date: null,
    app_window_text: null,
  };
}

function countPeople(current: CompanyPerson[], former: CompanyPerson[]) {
  return new Set([...current, ...former].map((p) => p.contact_id)).size;
}

function facetTabLabel(facet: LocationFacet): string {
  if (facet.key === "remote") return "Remote";
  if (facet.key === "unknown") return "Unknown";
  return formatOfficeTabLabel(facet.city, facet.state, facet.country);
}

function blockTabLabel(key: string, label: string, facet?: LocationFacet): string {
  if (key === "all") return "All";
  if (key === "general") return "General";
  if (facet) return facetTabLabel(facet);
  return label;
}

function notesForLocation(allNotes: CompanyNote[], facet: LocationFacet): CompanyNote[] {
  return allNotes.filter((n) => {
    if (facet.key === "remote" || facet.key === "unknown") return false;
    return n.location_id != null && String(n.location_id) === facet.key;
  });
}

export interface LocationTabsData {
  all: PreviewLocationBlock;
  /** Company-wide recruiting scope (general application, notes, status) — independent of offices */
  companyWide: PreviewLocationBlock | null;
  offices: PreviewLocationBlock[];
  /** Remote / Unknown — not offices; shown under All view only */
  unassigned: PreviewLocationBlock[];
}

function isOfficeFacetKey(key: string): boolean {
  return key !== "remote" && key !== "unknown";
}

export async function fetchLocationBlocks(
  userId: string,
  companyId: number,
): Promise<{
  company: CompanyDetail["company"];
  blocks: PreviewLocationBlock[];
  tabs: LocationTabsData;
  totalContacts: number;
  target: CompanyDetail["target"];
}> {
  const base = await getCompanyDetail(userId, companyId);
  if (!base) throw new Error("Company not found");

  const allNotes = base.target?.notes ?? [];
  const generalNotes = allNotes.filter((n) => n.location_id == null);

  const facetDetails = await Promise.all(
    base.facets.map((facet) => getCompanyDetail(userId, companyId, { locationKey: facet.key })),
  );

  const blocks: PreviewLocationBlock[] = [];
  const offices: PreviewLocationBlock[] = [];
  const unassigned: PreviewLocationBlock[] = [];

  if (generalNotes.length > 0 || base.target?.app_window_text) {
    blocks.push({
      key: "general",
      label: "General",
      tabLabel: "General",
      location_id: null,
      contactCount: countPeople(base.current, base.former),
      isTargeted: true,
      status: base.target?.status ?? "researching",
      next_app_date: base.target?.next_app_date ?? null,
      app_window_text: base.target?.app_window_text ?? null,
      notes: generalNotes,
      current: [],
      former: [],
      bench: [],
    });
  }

  let officeIndex = 0;
  base.facets.forEach((facet, index) => {
    const scoped = facetDetails[index];
    if (!scoped) return;

    const isOffice = isOfficeFacetKey(facet.key);
    const mock = isOffice
      ? mockTargetMeta(officeIndex++, base.target)
      : { isTargeted: false, status: null, next_app_date: null, app_window_text: null };

    const locNotes = notesForLocation(allNotes, facet);
    const block: PreviewLocationBlock = {
      key: facet.key,
      label: facet.label,
      tabLabel: facetTabLabel(facet),
      location_id: facet.location_id,
      contactCount: facet.count,
      ...mock,
      notes:
        locNotes.length > 0
          ? locNotes
          : mock.isTargeted && isOffice && officeIndex === 1
            ? [
                {
                  id: -1,
                  note: "Sample note — NYC apps historically open late August.",
                  created_at: new Date().toISOString(),
                  location_id: facet.location_id,
                  location_label: facet.label,
                },
              ]
            : [],
      current: scoped.current,
      former: scoped.former,
      bench: scoped.bench,
    };

    blocks.push(block);
    if (isOffice) offices.push(block);
    else unassigned.push(block);
  });

  offices.sort((a, b) => b.contactCount - a.contactCount || a.label.localeCompare(b.label));

  blocks.sort((a, b) => {
    if (a.isTargeted !== b.isTargeted) return a.isTargeted ? -1 : 1;
    return b.contactCount - a.contactCount || a.label.localeCompare(b.label);
  });

  const totalContacts = countPeople(base.current, base.former);

  const companyWideNotes = allNotes.filter((n) => n.location_id == null);

  const companyWide: PreviewLocationBlock | null = base.target
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

  const all: PreviewLocationBlock = {
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

  return { company: base.company, blocks, tabs: { all, companyWide, offices, unassigned }, totalContacts, target: base.target };
}

export const PREVIEW_VARIANTS = [
  { slug: "pipeline", label: "Pipeline", desc: "Wireframe layout — contacts left, vertical recruiting pipeline right, location dropdown" },
  { slug: "tabs", label: "Tabs", desc: "Like today’s page — location tabs (not filter chips), target + notes per tab" },
  { slug: "cards", label: "Cards", desc: "Two-column grid of location cards; click to open detail drawer" },
  { slug: "stack", label: "Stack", desc: "Full-width vertical blocks — targeted expanded, others collapsed" },
  { slug: "accordion", label: "Accordion", desc: "Compact list — every location is one accordion row" },
  { slug: "split", label: "Split", desc: "Location list on the left, selected location workspace on the right" },
] as const;

export type PreviewVariantSlug = (typeof PREVIEW_VARIANTS)[number]["slug"];
