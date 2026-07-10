"use client";

import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PreviewLocationBlock, PreviewVariantSlug } from "@/lib/company-location-preview";
import { PREVIEW_VARIANTS } from "@/lib/company-location-preview";
import type { CompanyPerson } from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import {
  ArrowLeft,
  ExternalLink,
  MapPin,
  Target,
  StickyNote,
  Mail,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  LayoutGrid,
} from "lucide-react";

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

const STAGE_STYLES: Record<OutreachStage, string> = {
  not_contacted: "bg-surface-container-high text-on-surface-variant",
  contacted: "bg-primary-container text-on-primary-container",
  bounced: "bg-error-container text-on-error-container",
  replied: "bg-tertiary-container text-on-tertiary-container",
  call_scheduled: "bg-secondary-container text-on-secondary-container",
  call_done: "bg-secondary-container text-on-secondary-container",
  referral: "bg-tertiary-container text-on-tertiary-container",
};

const PERSONA_LABELS: Record<string, string> = {
  alum_product: "Alum · Product",
  alum_other: "Alum",
  product_peer: "Product peer",
  product_leader: "Product leader",
  recruiter: "Recruiter",
};

export function PreviewBanner({
  companyId,
  activeVariant,
  companyName,
  minimal,
}: {
  companyId: number;
  activeVariant: PreviewVariantSlug;
  companyName: string;
  minimal?: boolean;
}) {
  if (minimal) {
    return (
      <div className="border-b border-outline-variant/30 bg-surface-container/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between gap-3">
          <span className="text-[11px] text-on-surface-variant">Preview · buttons disabled</span>
          <Link href={`/companies/${companyId}`} className="text-[11px] text-primary hover:underline shrink-0">
            Exit preview
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-50 border-b border-outline-variant/40 bg-tertiary-container/95 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-on-tertiary-container">
          Design preview · Location-first
        </span>
        <span className="text-xs text-on-tertiary-container/80 hidden sm:inline">
          {companyName} — interactions are non-functional
        </span>
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          <LayoutGrid className="w-3.5 h-3.5 text-on-tertiary-container/70" />
          {PREVIEW_VARIANTS.map((v) => (
            <Link
              key={v.slug}
              href={`/companies/${companyId}/preview/${v.slug}`}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                activeVariant === v.slug
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high/80 text-on-surface hover:bg-surface-container-high"
              }`}
            >
              {v.label}
            </Link>
          ))}
          <Link
            href={`/companies/${companyId}`}
            className="px-2.5 py-1 rounded-full text-xs text-on-tertiary-container/90 hover:underline ml-1"
          >
            Current page
          </Link>
        </div>
      </div>
    </div>
  );
}

export function CompanyHeaderThin({
  companyId,
  name,
  totalContacts,
  linkedinUrl,
  forTabs,
}: {
  companyId: number;
  name: string;
  totalContacts: number;
  linkedinUrl: string | null;
  forTabs?: boolean;
}) {
  return (
    <>
      <Link
        href={forTabs ? `/companies/${companyId}` : `/companies/${companyId}/preview`}
        className="group inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-4 -ml-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-surface-container-high"
      >
        <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" /> Companies
      </Link>
      <div className={forTabs ? "mb-4" : "mb-6"}>
        <h1 className="text-2xl font-semibold text-on-surface">{name}</h1>
        <div className="flex items-center gap-3 mt-1 text-sm text-on-surface-variant flex-wrap">
          <span>
            {totalContacts} contact{totalContacts === 1 ? "" : "s"}
            {!forTabs && " across all locations"}
          </span>
          {linkedinUrl && (
            <a
              href={linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-primary"
            >
              <ExternalLink className="w-3.5 h-3.5" /> LinkedIn
            </a>
          )}
        </div>
      </div>
    </>
  );
}

export function TargetStatusBar({ block }: { block: PreviewLocationBlock }) {
  if (!block.isTargeted) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[block.status ?? "researching"]}`}
      >
        {STATUS_LABELS[block.status ?? "researching"]}
      </span>
      {block.next_app_date && (
        <span className="text-xs text-primary font-medium">
          Apps: {new Date(`${block.next_app_date}T00:00:00`).toLocaleDateString()}
        </span>
      )}
      {block.app_window_text && (
        <span className="text-xs italic text-on-surface-variant truncate max-w-md" title={block.app_window_text}>
          {block.app_window_text}
        </span>
      )}
    </div>
  );
}

export function NotesSection({ block }: { block: PreviewLocationBlock }) {
  if (!block.isTargeted) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-on-surface flex items-center gap-1.5">
        <StickyNote className="w-3.5 h-3.5 text-primary" /> Recruiting notes
      </h3>
      {block.notes.length === 0 ? (
        <p className="text-xs text-on-surface-variant">No notes yet.</p>
      ) : (
        <div className="space-y-1.5">
          {block.notes.map((n) => (
            <div key={n.id} className="rounded-lg bg-surface-container-high/70 px-3 py-2">
              <p className="text-sm text-on-surface">{n.note}</p>
              <p className="text-[10px] text-on-surface-variant mt-1">
                {new Date(n.created_at).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-lg bg-surface-container-high/50 border border-dashed border-outline-variant/50 p-3">
        <p className="text-xs text-on-surface-variant italic">Note composer (preview)</p>
      </div>
    </div>
  );
}

export function PeopleListCompact({ people, title }: { people: CompanyPerson[]; title: string }) {
  if (people.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-on-surface mb-1.5">
        {title} <span className="font-normal text-on-surface-variant">({people.length})</span>
      </h3>
      <div className="space-y-1">
        {people.slice(0, 5).map((p) => (
          <div
            key={p.contact_id}
            className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface-container-high/60"
          >
            <ContactAvatar name={p.name} photoUrl={p.photo_url} className="w-8 h-8 text-xs" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-on-surface truncate">{p.name}</span>
                {p.stage && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${STAGE_STYLES[p.stage]}`}>
                    {STAGE_LABELS[p.stage]}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-on-surface-variant truncate">
                {p.roles[0]?.title ?? p.headline ?? ""}
              </p>
            </div>
            <Button size="sm" variant="text" disabled className="shrink-0 opacity-50">
              <Mail className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        {people.length > 5 && (
          <p className="text-[11px] text-on-surface-variant px-2">+{people.length - 5} more</p>
        )}
      </div>
    </div>
  );
}

export function PeopleListFull({ people, title }: { people: CompanyPerson[]; title: string }) {
  if (people.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-on-surface mb-2">
        {title} <span className="font-normal text-on-surface-variant">({people.length})</span>
      </h3>
      <div className="grid gap-2">
        {people.map((p) => (
          <Card key={p.contact_id}>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-3">
                <ContactAvatar name={p.name} photoUrl={p.photo_url} className="w-9 h-9 text-xs" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-on-surface">{p.name}</span>
                    {p.persona && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-surface-container-high text-on-surface-variant">
                        {PERSONA_LABELS[p.persona] ?? p.persona}
                      </span>
                    )}
                    {p.is_alum && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-primary-container text-on-primary-container flex items-center gap-1">
                        <GraduationCap className="w-3 h-3" /> BYU
                      </span>
                    )}
                    {p.stage && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] ${STAGE_STYLES[p.stage]}`}>
                        {STAGE_LABELS[p.stage]}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant truncate mt-0.5">
                    {p.roles[0]?.title ?? p.headline ?? ""}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function LocationBlockHeader({
  block,
  expanded,
  onToggle,
}: {
  block: PreviewLocationBlock;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const ToggleIcon = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex items-start justify-between gap-3">
      <button
        type="button"
        onClick={onToggle}
        className={`flex items-start gap-2 min-w-0 text-left ${onToggle ? "hover:opacity-80" : ""}`}
        disabled={!onToggle}
      >
        {onToggle && <ToggleIcon className="w-4 h-4 mt-1 shrink-0 text-on-surface-variant" />}
        <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <div>
          <h2 className="text-base font-semibold text-on-surface">{block.label}</h2>
          <p className="text-xs text-on-surface-variant mt-0.5">
            {block.contactCount} contact{block.contactCount === 1 ? "" : "s"}
            {block.key === "general" && " · company-wide intel"}
          </p>
        </div>
      </button>
      <div className="flex items-center gap-2 shrink-0">
        {block.isTargeted ? (
          <span className="flex items-center gap-1 text-xs font-medium text-primary">
            <Target className="w-3.5 h-3.5" /> Targeted
          </span>
        ) : (
          <Button size="sm" variant="tonal" disabled>
            Target
          </Button>
        )}
      </div>
    </div>
  );
}

export function LocationWorkspace({ block, compactPeople }: { block: PreviewLocationBlock; compactPeople?: boolean }) {
  const People = compactPeople ? PeopleListCompact : PeopleListFull;
  return (
    <div className="space-y-4 pt-3 border-t border-outline-variant/30">
      <TargetStatusBar block={block} />
      {block.key !== "general" && (
        <>
          <NotesSection block={block} />
          <People people={block.current} title="Current employees" />
          <People people={block.former} title="Former employees" />
          {block.bench.length > 0 && (
            <p className="text-xs text-on-surface-variant">▸ {block.bench.length} on bench</p>
          )}
        </>
      )}
      {block.key === "general" && <NotesSection block={block} />}
    </div>
  );
}
