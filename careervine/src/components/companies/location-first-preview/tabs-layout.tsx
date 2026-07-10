"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import type { LocationTabsData, PreviewLocationBlock } from "@/lib/company-location-preview";
import type { CompanyPerson } from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import { STATUS_LABELS, STATUS_STYLES } from "@/components/companies/location-first-preview/shared";
import { formatRoleLocationInList } from "@/lib/location-tab-label";
import {
  Target,
  StickyNote,
  Plus,
  ChevronDown,
  ChevronRight,
  Mail,
  GraduationCap,
  HelpCircle,
} from "lucide-react";

const PERSONA_LABELS: Record<string, string> = {
  alum_product: "Alum · Product",
  alum_other: "Alum",
  product_peer: "Product peer",
  product_leader: "Product leader",
  recruiter: "Recruiter",
};

const STAGE_STYLES: Record<OutreachStage, string> = {
  not_contacted: "bg-surface-container-high text-on-surface-variant",
  contacted: "bg-primary-container text-on-primary-container",
  bounced: "bg-error-container text-on-error-container",
  replied: "bg-tertiary-container text-on-tertiary-container",
  call_scheduled: "bg-secondary-container text-on-secondary-container",
  call_done: "bg-secondary-container text-on-secondary-container",
  referral: "bg-tertiary-container text-on-tertiary-container",
};

type TabEntry = { key: string; label: string; tabLabel: string; contactCount: number; isTargeted: boolean };

function CompanyWideBanner({ companyWide }: { companyWide: PreviewLocationBlock }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-1">
      <span className="text-xs font-medium text-on-surface-variant">Company-wide</span>
      <span
        className={`px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLES[companyWide.status ?? "researching"]}`}
      >
        {STATUS_LABELS[companyWide.status ?? "researching"]}
      </span>
      {companyWide.next_app_date && (
        <span className="text-xs text-on-surface-variant">
          Apps {new Date(`${companyWide.next_app_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
      )}
    </div>
  );
}

function OfficeWorkspaceHeader({
  block,
  isAll,
  companyWide,
  officeCount,
  targetedCount,
}: {
  block: PreviewLocationBlock;
  isAll: boolean;
  companyWide: PreviewLocationBlock | null;
  officeCount: number;
  targetedCount: number;
}) {
  if (isAll) {
    return (
      <header className="mb-6 pb-5 border-b border-outline-variant/25">
        <h2 className="text-lg font-semibold text-on-surface">All contacts</h2>
        <p className="text-sm text-on-surface-variant mt-1">
          {block.contactCount} people · {targetedCount}/{officeCount} offices tracked separately
        </p>

        <div className="mt-4 pt-4 border-t border-outline-variant/20">
          <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-2">
            General application
          </p>
          {companyWide?.isTargeted ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-on-surface-variant max-w-md">
                Track when you applied to the company overall — not tied to a specific office.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-9 inline-flex items-center px-3 rounded-lg text-sm font-medium ${STATUS_STYLES[companyWide.status ?? "researching"]}`}
                >
                  {STATUS_LABELS[companyWide.status ?? "researching"]}
                </span>
                <button type="button" disabled className="h-9 px-3 rounded-lg bg-surface-container-high text-sm text-on-surface-variant">
                  {companyWide.next_app_date
                    ? `Apps ${new Date(`${companyWide.next_app_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : "Set app date"}
                </button>
                <button type="button" disabled className="h-9 px-2 text-xs text-on-surface-variant">
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-on-surface-variant">No company-wide application tracked yet.</p>
              <Button variant="tonal" size="sm" disabled>
                <Target className="w-4 h-4 mr-1.5" /> Track general application
              </Button>
            </div>
          )}
          {companyWide?.app_window_text && (
            <p className="text-xs italic text-on-surface-variant mt-3">{companyWide.app_window_text}</p>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="mb-6 pb-5 border-b border-outline-variant/25">
      {companyWide?.isTargeted && (
        <div className="mb-3">
          <CompanyWideBanner companyWide={companyWide} />
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">{block.label}</h2>
          <p className="text-sm text-on-surface-variant mt-0.5">
            {block.contactCount} contact{block.contactCount === 1 ? "" : "s"}
          </p>
        </div>

        {block.isTargeted ? (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`h-9 inline-flex items-center px-3 rounded-lg text-sm font-medium ${STATUS_STYLES[block.status ?? "researching"]}`}
            >
              {STATUS_LABELS[block.status ?? "researching"]}
            </span>
            <button
              type="button"
              disabled
              className="h-9 px-3 rounded-lg bg-surface-container-high text-sm text-on-surface-variant"
            >
              {block.next_app_date
                ? `Apps ${new Date(`${block.next_app_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                : "Set app date"}
            </button>
            <button type="button" disabled className="h-9 px-2 text-xs text-on-surface-variant">
              Remove
            </button>
          </div>
        ) : (
          <Button variant="tonal" size="sm" disabled>
            <Target className="w-4 h-4 mr-1.5" /> Target this office
          </Button>
        )}
      </div>

      {block.isTargeted && block.app_window_text && (
        <p className="text-xs italic text-on-surface-variant mt-3">{block.app_window_text}</p>
      )}
      {!block.isTargeted && (
        <p className="text-xs text-on-surface-variant mt-3">
          Target this office to track recruiting status and log notes here.
        </p>
      )}
    </header>
  );
}

function PersonRow({
  person,
  showRoleLocation,
}: {
  person: CompanyPerson;
  showRoleLocation?: boolean;
}) {
  const role = person.roles[0];
  const locationSuffix =
    showRoleLocation && role ? formatRoleLocationInList(role) : null;

  return (
    <div className="flex items-center gap-3 py-2.5 px-1 -mx-1 rounded-lg hover:bg-surface-container-high/80 transition-colors">
      <ContactAvatar name={person.name} photoUrl={person.photo_url} className="w-9 h-9 text-xs shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link href={`/contacts/${person.contact_id}`} className="text-sm font-medium text-on-surface hover:text-primary truncate">
            {person.name}
          </Link>
          {person.persona && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-container-high text-on-surface-variant">
              {PERSONA_LABELS[person.persona] ?? person.persona}
            </span>
          )}
          {person.is_alum && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary-container text-on-primary-container flex items-center gap-0.5">
              <GraduationCap className="w-2.5 h-2.5" /> BYU
            </span>
          )}
          {person.stage && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${STAGE_STYLES[person.stage]}`}>
              {STAGE_LABELS[person.stage]}
            </span>
          )}
        </div>
        <p className="text-xs text-on-surface-variant truncate mt-0.5">
          {role?.title ?? person.headline ?? ""}
          {locationSuffix && <> · {locationSuffix}</>}
        </p>
      </div>
      {person.email && (
        <Button size="sm" variant="text" disabled className="shrink-0 opacity-50 h-8 w-8 p-0">
          <Mail className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}

function PeopleSection({
  title,
  people,
  showRoleLocation,
}: {
  title: string;
  people: CompanyPerson[];
  showRoleLocation?: boolean;
}) {
  if (people.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-1">
        {title} · {people.length}
      </h3>
      <div className="divide-y divide-outline-variant/20">
        {people.map((p) => (
          <PersonRow key={p.contact_id} person={p} showRoleLocation={showRoleLocation} />
        ))}
      </div>
    </section>
  );
}

function BenchSection({ bench }: { bench: CompanyPerson[] }) {
  const [open, setOpen] = useState(false);
  if (bench.length === 0) return null;
  return (
    <section className="pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-on-surface-variant hover:text-on-surface"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {bench.length} on bench
      </button>
      {open && (
        <div className="mt-1 divide-y divide-outline-variant/20">
          {bench.map((p) => (
            <PersonRow key={p.contact_id} person={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function NotesPanel({
  block,
  companyWide,
  isAll,
}: {
  block: PreviewLocationBlock;
  companyWide: PreviewLocationBlock | null;
  isAll: boolean;
}) {
  return (
    <aside className="lg:sticky lg:top-20 lg:self-start space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant flex items-center gap-1.5">
        <StickyNote className="w-3.5 h-3.5" /> Notes
      </h3>

      {isAll ? (
        <>
          <p className="text-[11px] text-on-surface-variant">Company-wide notes (general intel, not office-specific).</p>
          {companyWide?.isTargeted ? (
            <>
              <textarea
                readOnly
                placeholder="General company intel (referral process, program-wide timing…)"
                rows={2}
                className="w-full rounded-lg bg-surface-container-high/80 px-3 py-2 text-sm text-on-surface outline-none resize-none"
              />
              <Button size="sm" disabled className="w-full">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add note
              </Button>
              {(companyWide.notes.length > 0 || block.notes.some((n) => n.location_id != null)) && (
                <ul className="space-y-3 pt-2">
                  {companyWide.notes.map((n) => (
                    <li key={n.id} className="text-sm text-on-surface pl-3 border-l-2 border-primary/30">
                      <p className="whitespace-pre-wrap leading-snug">{n.note}</p>
                      <p className="text-[10px] text-on-surface-variant mt-1.5">
                        {new Date(n.created_at).toLocaleDateString()} · Company-wide
                      </p>
                    </li>
                  ))}
                  {block.notes
                    .filter((n) => n.location_id != null)
                    .map((n) => (
                      <li key={`loc-${n.id}`} className="text-sm text-on-surface pl-3 border-l-2 border-outline-variant/40 opacity-80">
                        <p className="whitespace-pre-wrap leading-snug">{n.note}</p>
                        <p className="text-[10px] text-on-surface-variant mt-1.5">
                          {new Date(n.created_at).toLocaleDateString()}
                          {n.location_label ? <> · {n.location_label}</> : null}
                        </p>
                      </li>
                    ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-xs text-on-surface-variant">Track a general application to add company-wide notes.</p>
          )}
        </>
      ) : block.isTargeted ? (
        <>
          <textarea
            readOnly
            placeholder="What did you learn?"
            rows={2}
            className="w-full rounded-lg bg-surface-container-high/80 px-3 py-2 text-sm text-on-surface outline-none resize-none"
          />
          <Button size="sm" disabled className="w-full">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add note
          </Button>
          {block.notes.length > 0 && (
            <ul className="space-y-3 pt-2">
              {block.notes.map((n) => (
                <li key={n.id} className="text-sm text-on-surface pl-3 border-l-2 border-outline-variant/50">
                  <p className="whitespace-pre-wrap leading-snug">{n.note}</p>
                  <p className="text-[10px] text-on-surface-variant mt-1">{new Date(n.created_at).toLocaleDateString()}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-xs text-on-surface-variant">Target this office to add notes.</p>
      )}
    </aside>
  );
}

function UnassignedFootnote({ blocks }: { blocks: PreviewLocationBlock[] }) {
  if (blocks.length === 0) return null;
  const parts = blocks.map((b) => `${b.contactCount} ${b.label.toLowerCase()}`);
  return (
    <p className="text-[11px] text-on-surface-variant flex items-start gap-1.5 pt-4 mt-4 border-t border-outline-variant/20">
      <HelpCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        {parts.join(" and ")} included above — not company offices, no separate tab.
      </span>
    </p>
  );
}

function TabPanelContent({
  block,
  tabs,
  isAll,
}: {
  block: PreviewLocationBlock;
  tabs: LocationTabsData;
  isAll: boolean;
}) {
  return (
    <>
      <OfficeWorkspaceHeader
        block={block}
        isAll={isAll}
        companyWide={tabs.companyWide}
        officeCount={tabs.offices.length}
        targetedCount={tabs.offices.filter((o) => o.isTargeted).length}
      />

      <div className="grid lg:grid-cols-[1fr_240px] xl:grid-cols-[1fr_280px] gap-8 lg:gap-10">
        <div className="space-y-6 min-w-0">
          <PeopleSection title="Current" people={block.current} showRoleLocation={isAll} />
          <PeopleSection title="Former" people={block.former} showRoleLocation={isAll} />
          <BenchSection bench={block.bench} />
          {isAll && <UnassignedFootnote blocks={tabs.unassigned} />}
        </div>
        <NotesPanel block={block} companyWide={tabs.companyWide} isAll={isAll} />
      </div>
    </>
  );
}

export function TabsLayout({ tabs }: { tabs: LocationTabsData }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabEntries = useMemo<TabEntry[]>(() => {
    const all: TabEntry = {
      key: "all",
      label: tabs.all.label,
      tabLabel: tabs.all.tabLabel,
      contactCount: tabs.all.contactCount,
      isTargeted: false,
    };
    const officeTabs = tabs.offices.map((o) => ({
      key: o.key,
      label: o.label,
      tabLabel: o.tabLabel,
      contactCount: o.contactCount,
      isTargeted: o.isTargeted,
    }));
    return [all, ...officeTabs];
  }, [tabs]);

  const tabFromUrl = searchParams.get("tab");
  const [activeKey, setActiveKey] = useState("all");

  useEffect(() => {
    if (tabFromUrl && tabEntries.some((t) => t.key === tabFromUrl)) {
      setActiveKey(tabFromUrl);
    } else if (!tabEntries.some((t) => t.key === activeKey)) {
      setActiveKey("all");
    }
  }, [tabFromUrl, tabEntries, activeKey]);

  const activeBlock =
    activeKey === "all" ? tabs.all : tabs.offices.find((o) => o.key === activeKey) ?? tabs.all;

  const selectTab = (key: string) => {
    setActiveKey(key);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", key);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  if (tabEntries.length <= 1) {
    return <p className="text-sm text-on-surface-variant py-8">No offices with contacts yet.</p>;
  }

  return (
    <div>
      {/* Wrapped office pills — no horizontal scrollbar */}
      <div className="flex flex-wrap gap-2 mb-2" role="tablist" aria-label="Offices">
        {tabEntries.map((tab) => {
          const isActive = tab.key === activeKey;

          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={tab.label !== tab.tabLabel ? tab.label : undefined}
              onClick={() => selectTab(tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
                isActive
                  ? "bg-primary text-on-primary shadow-sm"
                  : "bg-surface-container-high/70 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              <span className="font-medium">{tab.tabLabel}</span>
              <span className={`text-xs tabular-nums ${isActive ? "opacity-90" : "opacity-70"}`}>
                {tab.contactCount}
              </span>
              {tab.isTargeted && (
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-on-primary" : "bg-primary"}`}
                  aria-label="Targeted"
                />
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="animate-in fade-in duration-150">
        <TabPanelContent block={activeBlock} tabs={tabs} isAll={activeKey === "all"} />
      </div>
    </div>
  );
}
