"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { STATUS_LABELS, STATUS_STYLES } from "@/components/companies/company-filter-bar";
import { STAGE_LABELS } from "@/lib/stage-derivation";
import { nextActionForCompany, type NextActionTone } from "@/lib/company-next-action";
import type { CompanySummary } from "@/lib/company-queries";
import {
  Users,
  UsersRound,
  GraduationCap,
  Briefcase,
  ChevronRight,
  MapPin,
  Archive,
  Sparkles,
  CalendarClock,
  CalendarX,
  Handshake,
  Phone,
  MailOpen,
  MailX,
  MessageSquare,
  Send,
  UserPlus,
  Clock,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useAlumniAffinity } from "@/hooks/use-alumni-affinity";
import {
  EMPTY_SELECTION,
  companyHref,
  matchedOffices,
  scopedCounts,
  type LocationSelection,
} from "@/lib/company-location-filter";

/** lucide names the next-action ladder returns → components. */
const ACTION_ICONS: Record<string, LucideIcon> = {
  Archive,
  Sparkles,
  CalendarClock,
  CalendarX,
  Handshake,
  Phone,
  MailOpen,
  MailX,
  MessageSquare,
  Send,
  GraduationCap,
  UserPlus,
  Clock,
  Search,
};

// The next-action chip carries the card's emphasis; three tiers, all on-brand
// green so nothing reads as an alarm. Urgent pops (solid), active is a live
// move (soft), muted is dormant (neutral).
const TONE_CHIP: Record<NextActionTone, string> = {
  urgent: "bg-primary text-primary-foreground",
  active: "bg-primary-container text-on-primary-container",
  muted: "bg-surface-container-high text-on-surface-variant",
};

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A single company on the /companies list. Leads with the two things a
 * job-seeker actually needs: who you know here (quality, not a raw count)
 * and the one next move (CAR-10).
 */
export function CompanyCard({
  company: c,
  locationSelection,
}: {
  company: CompanySummary;
  /** Active location filter, so the card reports the places the user asked for. */
  locationSelection?: LocationSelection;
}) {
  const affinity = useAlumniAffinity();
  const action = nextActionForCompany(c);
  const ActionIcon = ACTION_ICONS[action.icon] ?? Sparkles;

  // While a location filter is active the counts describe the SELECTED offices
  // only (CAR-251). The unscoped RPC counts stay the source of truth otherwise,
  // so nothing about the default view changes.
  const sel = locationSelection?.active ? locationSelection : null;
  const scoped = sel ? scopedCounts(c, sel) : null;
  const matched = sel ? matchedOffices(c, sel) : [];
  const currentCount = scoped ? scoped.current : c.current_count;
  const formerCount = scoped ? scoped.former : c.former_count;
  const benchCount = scoped ? scoped.bench : c.bench_count;
  const alumCount = scoped ? scoped.alum : c.alum_count;
  const productAlumCount = scoped ? scoped.product_alum : c.product_alum_count;
  const recruiterCount = scoped ? scoped.recruiter : c.recruiter_count;
  const knownTotal = currentCount + formerCount;
  // Where the scoped view is blind. Only about half of current roles carry a
  // location, so without this a company with nine contacts reads "1 person" and
  // looks identical to one with a single employee.
  const unknownCount = scoped?.unknown ?? 0;
  const scopeLabel = matched.length === 1 ? matched[0].label : matched.length > 1 ? `${matched.length} offices` : null;

  return (
    <Link href={companyHref(c, sel ?? EMPTY_SELECTION)} className="block group">
      <Card className="transition-shadow group-hover:shadow-md">
        <CardContent className="py-4 px-5">
          <div className="flex items-center gap-4">
            {/* Logo / initial */}
            <div className="w-11 h-11 rounded-xl bg-surface-container-highest border border-outline-variant flex items-center justify-center overflow-hidden shrink-0">
              {c.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.logo_url} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-lg font-semibold text-on-surface-variant">{c.name.charAt(0).toUpperCase()}</span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              {/* Title row */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-on-surface truncate">{c.name}</span>
                {c.target && (
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[c.target.status] ?? STATUS_STYLES.researching}`}
                  >
                    {STATUS_LABELS[c.target.status] ?? c.target.status}
                  </span>
                )}
                {scopeLabel && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs bg-surface-container-high text-on-surface-variant">
                    {scopeLabel}
                  </span>
                )}
                {c.target?.program_name && (
                  <span className="text-xs text-on-surface-variant truncate">· {c.target.program_name}</span>
                )}
              </div>

              {/* Who you know — quality signals, not just a count */}
              <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 text-xs flex-wrap">
                {currentCount > 0 ? (
                  <span className="flex items-center gap-1 text-on-surface-variant">
                    <Users className="w-3.5 h-3.5" />
                    {pluralize(currentCount, "person", "people")}
                    {scoped && matched.length === 1 && ` in ${matched[0].label}`}
                  </span>
                ) : knownTotal > 0 ? (
                  <span className="flex items-center gap-1 text-on-surface-variant">
                    <UsersRound className="w-3.5 h-3.5" />
                    {pluralize(formerCount, "former contact", "former contacts")}
                  </span>
                ) : unknownCount === 0 ? (
                  <span className="flex items-center gap-1 text-on-surface-variant/80">
                    <UserPlus className="w-3.5 h-3.5" />
                    {scoped ? "Nobody here yet" : "No contacts yet"}
                  </span>
                ) : null}
                {unknownCount > 0 && (
                  <span className="text-on-surface-variant/70">
                    {pluralize(unknownCount, "contact", "contacts")} location unknown
                  </span>
                )}
                {/* CAR-213: `abbr` is the VIEWER's school, so a USU student
                    reads "2 USU alumni". Escape-hatch schools have no curated
                    abbreviation and drop the school entirely rather than
                    render a truncated free-text name. The counts are already
                    zero without affinity — company-queries computes them
                    against the viewer's school — so no extra gate is needed
                    here, and adding one would hide a real signal. */}
                {productAlumCount > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2 py-0.5 text-on-primary-container font-medium">
                    <GraduationCap className="w-3.5 h-3.5" />
                    {affinity.abbr
                      ? `${pluralize(productAlumCount, `${affinity.abbr} alum`, `${affinity.abbr} alumni`)} in product`
                      : `${pluralize(productAlumCount, "alum", "alumni")} in product`}
                  </span>
                ) : (
                  alumCount > 0 && (
                    <span className="flex items-center gap-1 text-primary font-medium">
                      <GraduationCap className="w-3.5 h-3.5" />
                      {affinity.abbr
                        ? pluralize(alumCount, `${affinity.abbr} alum`, `${affinity.abbr} alumni`)
                        : pluralize(alumCount, "alum", "alumni")}
                    </span>
                  )
                )}
                {recruiterCount > 0 && (
                  <span className="flex items-center gap-1 text-on-surface-variant">
                    <Briefcase className="w-3.5 h-3.5" />
                    {pluralize(recruiterCount, "recruiter", "recruiters")}
                  </span>
                )}
                {benchCount > 0 && (
                  <span className="text-on-surface-variant/70">{benchCount} benched</span>
                )}
              </div>

              {/* The one next move */}
              <div className={`mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 ${TONE_CHIP[action.tone]}`}>
                <ActionIcon className="w-3.5 h-3.5 shrink-0" />
                <span className="text-xs font-medium">{action.text}</span>
              </div>

              {/* Office scopes — only when location-level targets exist (§21.5) */}
              {c.office_scopes.length > 0 && (
                <div className="flex items-center gap-1.5 mt-1.5 text-xs text-on-surface-variant flex-wrap">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  {c.office_scopes.slice(0, 2).map((s, i) => (
                    <span key={s.location_id} className="truncate">
                      {i > 0 && <span className="opacity-60">· </span>}
                      {s.label} · {STATUS_LABELS[s.status] ?? s.status}
                    </span>
                  ))}
                  {c.office_scopes.length > 2 && (
                    <span className="opacity-70">+{c.office_scopes.length - 2} more</span>
                  )}
                </div>
              )}
            </div>

            {/* Traction badge (secondary) + open affordance */}
            <div className="flex items-center gap-2 shrink-0">
              {c.traction && c.traction !== "not_contacted" && (
                <span className="hidden sm:inline-flex px-2.5 py-0.5 rounded-full text-xs bg-tertiary-container text-on-tertiary-container">
                  {STAGE_LABELS[c.traction]}
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
