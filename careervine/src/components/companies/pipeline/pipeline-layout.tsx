"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { DiscoveryCard } from "@/components/companies/discovery-card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { LocationBlock, LocationTabsData } from "@/lib/company-scopes";
import type { CompanyOffice, CompanyPerson } from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import { formatRoleLocationInList } from "@/lib/location-tab-label";
import {
  PIPELINE_STAGES,
  type CycleFormState,
  type PipelineStage,
  type PipelineState,
  getActiveCycleState,
  getScopeState,
} from "@/lib/pipeline-state";
import type { PipelineActions, PipelineSaveStatus } from "@/hooks/use-pipeline-autosave";
import {
  Search,
  Mail,
  GraduationCap,
  Target,
  Check,
  Trash2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MapPin,
  Briefcase,
  ExternalLink,
  UserPlus,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { ResearchingNotesEditor } from "@/components/companies/pipeline/researching-notes";
import { ResearchingProgramsEditor } from "@/components/companies/pipeline/researching-programs";
import { AppliedApplicationsEditor } from "@/components/companies/pipeline/applied-applications";
import { InterviewingRoundsEditor } from "@/components/companies/pipeline/interviewing-rounds";
import { ManageOfficesPanel } from "@/components/companies/pipeline/manage-offices-panel";
import { formatProgramSummaryLine } from "@/lib/researching-program-summary";
import { formatApplicationSummaryLine } from "@/lib/applied-application-summary";
import { formatApplicationDateDisplay } from "@/lib/application-date-value";

const STAGE_HEADINGS: Record<PipelineStage, string> = {
  researching: "Researching",
  outreach_active: "Active outreach",
  applied: "Applied",
  interviewing: "Interviewing",
  closed: "Closed",
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

const SAVE_STATUS_LABELS: Record<PipelineSaveStatus, string | null> = {
  idle: null,
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed — check your connection",
};

function stageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

/** "coffee · Jul 8" — latest logged touchpoint, shown in the outreach stage. */
function lastInteractionSuffix(person: CompanyPerson): string | null {
  const li = person.last_interaction;
  if (!li) return null;
  const date = new Date(li.date);
  const when = Number.isNaN(date.getTime())
    ? ""
    : ` · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return `${li.type}${when}`;
}

function PipelineStepList({
  progressStage,
  expandedStage,
  onStageClick,
  renderStageContent,
  renderStageSummary,
}: {
  progressStage: PipelineStage;
  expandedStage: PipelineStage;
  onStageClick: (stage: PipelineStage) => void;
  renderStageContent: (stage: PipelineStage) => ReactNode;
  renderStageSummary: (stage: PipelineStage) => ReactNode;
}) {
  const progressIndex = stageIndex(progressStage);

  return (
    <div className="relative pl-7">
      <div
        className="absolute left-[7px] top-3 bottom-3 w-px bg-outline-variant/40 pointer-events-none"
        aria-hidden
      />

      <ul className="space-y-1">
        {PIPELINE_STAGES.map((stage, index) => {
          const isReached = index <= progressIndex;
          const isExpanded = stage === expandedStage;
          const isFuture = index > progressIndex;
          const showSummary = isReached && !isExpanded;

          return (
            <li key={stage} className="relative">
              <button
                type="button"
                onClick={() => onStageClick(stage)}
                aria-pressed={isExpanded}
                aria-label={`${isExpanded ? "Editing" : "View"} ${STAGE_HEADINGS[stage]}`}
                className={`absolute -left-7 top-2 z-[1] w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                  isExpanded
                    ? "border-primary bg-primary text-on-primary"
                    : isReached
                      ? "border-primary bg-surface-container-lowest text-primary"
                      : "border-outline-variant bg-surface-container-lowest hover:border-primary/50"
                }`}
              >
                {isReached && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
              </button>

              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => onStageClick(stage)}
                  className={`w-full text-left rounded-lg px-2 py-1.5 transition-colors ${
                    isExpanded ? "bg-primary-container/25" : "hover:bg-surface-container-high/60"
                  }`}
                >
                  <span
                    className={`text-sm font-medium leading-none ${
                      isExpanded
                        ? "text-primary"
                        : isFuture
                          ? "text-on-surface-variant"
                          : "text-on-surface"
                    }`}
                  >
                    {STAGE_HEADINGS[stage]}
                  </span>
                </button>

                {showSummary && (
                  <button
                    type="button"
                    onClick={() => onStageClick(stage)}
                    className="w-full text-left px-2 pb-2 pt-0.5 hover:bg-surface-container-high/40 rounded-lg transition-colors"
                  >
                    <div className="pl-2 border-l-2 border-primary/20 space-y-1">
                      {renderStageSummary(stage)}
                    </div>
                  </button>
                )}

                <div
                  className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
                    isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                  }`}
                >
                  <div className="overflow-hidden min-h-0">
                    <div className={isExpanded ? "pt-2 pb-2" : ""}>
                      <div className="rounded-lg border border-primary/30 bg-primary-container/10 p-3 space-y-3">
                        {renderStageContent(stage)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value?: string | null }) {
  const text = value?.trim();
  if (!text) return null;
  return (
    <p className="text-xs leading-relaxed">
      <span className="text-on-surface-variant">{label}: </span>
      <span className="text-on-surface">{text}</span>
    </p>
  );
}

function StageSummary({
  stage,
  cycleForm,
  scopeLabel,
  isCompanyScope,
  outreachContacts,
}: {
  stage: PipelineStage;
  cycleForm: CycleFormState;
  scopeLabel: string;
  isCompanyScope: boolean;
  outreachContacts: CompanyPerson[];
}) {
  const { researching, applied, interviewing } = cycleForm;

  switch (stage) {
    case "researching": {
      const programLines = researching.programs
        .map(formatProgramSummaryLine)
        .filter((line): line is string => Boolean(line));
      const hasNotes = researching.notes.some((n) => n.body.trim());
      const hasAny = programLines.length > 0 || hasNotes;
      if (!hasAny) {
        return <p className="text-xs text-on-surface-variant italic">No details yet</p>;
      }
      return (
        <>
          {programLines.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-on-surface-variant">Programs</p>
              <ul className="space-y-1">
                {programLines.map((line, index) => (
                  <li key={index} className="text-xs text-on-surface leading-relaxed">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasNotes && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-on-surface-variant">Notes</p>
              <ul className="space-y-1">
                {researching.notes
                  .filter((n) => n.body.trim())
                  .map((n) => (
                    <li key={n.id} className="text-xs text-on-surface leading-relaxed">
                      {n.body}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </>
      );
    }
    case "outreach_active":
      if (outreachContacts.length === 0) {
        return <p className="text-xs text-on-surface-variant italic">No outreach logged yet</p>;
      }
      return (
        <ul className="space-y-1">
          {outreachContacts.map((p) => (
            <li key={p.contact_id} className="text-xs text-on-surface leading-relaxed">
              {p.name.split(" ")[0]}
              {p.stage && (
                <span className="text-on-surface-variant"> · {STAGE_LABELS[p.stage]}</span>
              )}
              {lastInteractionSuffix(p) && (
                <span className="text-on-surface-variant"> · {lastInteractionSuffix(p)}</span>
              )}
            </li>
          ))}
        </ul>
      );
    case "applied": {
      const applicationLines = applied.applications
        .map((application) => {
          const line = formatApplicationSummaryLine(
            isCompanyScope
              ? application
              : {
                  ...application,
                  location: application.location.trim() || scopeLabel,
                },
          );
          return line;
        })
        .filter((line): line is string => Boolean(line));
      if (applicationLines.length === 0) {
        return <p className="text-xs text-on-surface-variant italic">No application details yet</p>;
      }
      return (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-on-surface-variant">Applications</p>
          <ul className="space-y-1">
            {applicationLines.map((line, index) => (
              <li key={index} className="text-xs text-on-surface leading-relaxed">
                {line}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "interviewing": {
      const filledRounds = interviewing.rounds.filter(
        (r) => r.date.trim() || r.interviewer.trim() || r.questions.trim(),
      );
      if (filledRounds.length === 0) {
        return <p className="text-xs text-on-surface-variant italic">No interview details yet</p>;
      }
      return (
        <div className="space-y-2">
          {filledRounds.map((round, roundIndex) => (
            <div key={round.id} className="space-y-0.5">
              <p className="text-[11px] font-medium text-on-surface-variant">Round {roundIndex + 1}</p>
              <SummaryLine label="Date" value={formatApplicationDateDisplay(round.date)} />
              <SummaryLine label="Interviewer" value={round.interviewer} />
              <SummaryLine label="Notes" value={round.questions} />
            </div>
          ))}
        </div>
      );
    }
    case "closed":
      if (cycleForm.closed.declinedNextCycle) {
        return (
          <p className="text-xs text-on-surface-variant">
            Cycle closed · not preparing another application
          </p>
        );
      }
      return <p className="text-xs text-on-surface-variant">Cycle closed</p>;
  }
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-on-surface-variant">{label}</label>
      {children}
    </div>
  );
}

function StageFormFields({
  stage,
  cycleForm,
  userId,
  isCompanyScope,
  scopeLabel,
  outreachContacts,
  block,
  onPatchCycle,
  onStartNextCycle,
}: {
  stage: PipelineStage;
  cycleForm: CycleFormState;
  userId: string;
  isCompanyScope: boolean;
  scopeLabel: string;
  outreachContacts: CompanyPerson[];
  block: LocationBlock | null;
  onPatchCycle: (patch: (prev: CycleFormState) => CycleFormState) => void;
  onStartNextCycle: () => void;
}) {
  const { researching, applied, interviewing, closed } = cycleForm;

  switch (stage) {
    case "researching":
      return (
        <>
          <FieldRow label="Programs">
            <ResearchingProgramsEditor
              programs={researching.programs}
              onChange={(programs) =>
                onPatchCycle((prev) => ({
                  ...prev,
                  researching: { ...prev.researching, programs },
                }))
              }
            />
          </FieldRow>
          <FieldRow label="Notes">
            <ResearchingNotesEditor
              notes={researching.notes}
              onChange={(notes) =>
                onPatchCycle((prev) => ({
                  ...prev,
                  researching: { ...prev.researching, notes },
                }))
              }
              intelNotes={block?.notes}
            />
          </FieldRow>
        </>
      );
    case "outreach_active":
      return outreachContacts.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">No outreach logged yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {outreachContacts.slice(0, 4).map((p) => (
            <li key={p.contact_id} className="text-sm text-on-surface">
              Contact made with{" "}
              <Link href={`/contacts/${p.contact_id}`} className="font-medium hover:text-primary">
                {p.name.split(" ")[0]}
              </Link>
              {p.stage && (
                <span className="text-xs text-on-surface-variant ml-1">· {STAGE_LABELS[p.stage]}</span>
              )}
              {lastInteractionSuffix(p) && (
                <span className="text-xs text-on-surface-variant ml-1">· {lastInteractionSuffix(p)}</span>
              )}
            </li>
          ))}
        </ul>
      );
    case "applied":
      return (
        <FieldRow label="Applications">
          <AppliedApplicationsEditor
            userId={userId}
            applications={applied.applications}
            isCompanyScope={isCompanyScope}
            defaultLocation={scopeLabel}
            onChange={(applications) =>
              onPatchCycle((prev) => ({
                ...prev,
                applied: { applications },
              }))
            }
          />
        </FieldRow>
      );
    case "interviewing":
      return (
        <FieldRow label="Interview rounds">
          <InterviewingRoundsEditor
            rounds={interviewing.rounds}
            onChange={(rounds) =>
              onPatchCycle((prev) => ({
                ...prev,
                interviewing: { rounds },
              }))
            }
          />
        </FieldRow>
      );
    case "closed":
      if (closed.declinedNextCycle) {
        return (
          <>
            <p className="text-sm text-on-surface">
              This cycle is closed. You&apos;re not tracking another application cycle here.
            </p>
            <Button
              size="sm"
              variant="text"
              onClick={() =>
                onPatchCycle((prev) => ({
                  ...prev,
                  closed: { declinedNextCycle: false },
                }))
              }
            >
              Changed your mind?
            </Button>
          </>
        );
      }
      return (
        <>
          <p className="text-sm text-on-surface">Prepare for next application cycle?</p>
          <div className="flex gap-2">
            <Button size="sm" variant="tonal" onClick={onStartNextCycle}>
              Yes
            </Button>
            <Button
              size="sm"
              variant="text"
              onClick={() =>
                onPatchCycle((prev) => ({
                  ...prev,
                  closed: { declinedNextCycle: true },
                }))
              }
            >
              No
            </Button>
          </div>
        </>
      );
  }
}

function CycleTab({
  cycle,
  active,
  onSelect,
  onDelete,
}: {
  cycle: number;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group flex-1 min-w-0">
      <button
        type="button"
        onClick={onSelect}
        className={`w-full py-1.5 pr-5 text-xs font-medium rounded-md transition-colors ${
          active
            ? "bg-surface-container-lowest text-on-surface shadow-sm"
            : "text-on-surface-variant hover:text-on-surface"
        }`}
      >
        Cycle {cycle}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete cycle ${cycle}`}
        className="absolute top-0.5 right-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 text-error hover:bg-error-container/40 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/30 transition-opacity"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

function ContactEmailAction({
  person,
  gmailConnected,
  onCompose,
}: {
  person: CompanyPerson;
  gmailConnected: boolean;
  onCompose: (opts: { to: string; name: string; contactId: number }) => void;
}) {
  const email = person.email;
  if (!email) return null;

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {email.source === "pattern_guessed" && !email.bounced && (
        <Tooltip label="Pattern-guessed address — verify before heavy outreach">
          <AlertTriangle className="w-4 h-4 text-yellow-600" />
        </Tooltip>
      )}
      {email.bounced ? (
        <Tooltip label="This address bounced — sending is disabled">
          <span className="text-[11px] text-error font-medium">bounced</span>
        </Tooltip>
      ) : gmailConnected ? (
        <Tooltip label={`Email ${email.address}`}>
          <button
            type="button"
            onClick={() => onCompose({ to: email.address, name: person.name, contactId: person.contact_id })}
            className="p-1.5 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high cursor-pointer transition-colors"
          >
            <Mail className="w-4 h-4" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip label="Connect Gmail to email contacts">
          <span className="p-1.5 rounded-lg text-on-surface-variant/40">
            <Mail className="w-4 h-4" />
          </span>
        </Tooltip>
      )}
    </div>
  );
}

export type ContactTier = "active" | "prospect" | "bench";

/**
 * Tier-move icon stack from the contacts list: add to network on top,
 * prospect⇄archive below. Hidden for contacts already in the network.
 */
function TierMoves({
  person,
  onSetTier,
}: {
  person: CompanyPerson;
  onSetTier: (person: CompanyPerson, tier: ContactTier) => void;
}) {
  if (person.network_status === "active") return null;

  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <Tooltip label="Add to network">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSetTier(person, "active");
          }}
          className="p-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high cursor-pointer transition-colors"
        >
          <UserPlus className="w-4 h-4" />
        </button>
      </Tooltip>
      {person.network_status === "prospect" ? (
        <Tooltip label="Move to archive">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSetTier(person, "bench");
            }}
            className="p-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high cursor-pointer transition-colors"
          >
            <Archive className="w-4 h-4" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip label="Move to prospects">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSetTier(person, "prospect");
            }}
            className="p-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high cursor-pointer transition-colors"
          >
            <ArchiveRestore className="w-4 h-4" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function staleness(lastScrapedAt: string | null): string | null {
  if (!lastScrapedAt) return null;
  return `Data as of ${new Date(lastScrapedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function ContactRow({
  person,
  isFormer,
  showLocation,
  gmailConnected,
  onCompose,
  onSetTier,
}: {
  person: CompanyPerson;
  isFormer: boolean;
  showLocation?: boolean;
  gmailConnected: boolean;
  onCompose: (opts: { to: string; name: string; contactId: number }) => void;
  onSetTier: (person: CompanyPerson, tier: ContactTier) => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const role = person.roles[0];
  const locationSuffix = role ? formatRoleLocationInList(role) : null;
  const whySelected = person.selection_reason ?? person.review_note;
  const stale = staleness(person.last_scraped_at);

  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest hover:border-outline-variant hover:shadow-sm transition-all">
      <div
        className="flex items-center gap-3 py-3 px-3 cursor-pointer"
        onClick={() => router.push(`/contacts/${person.contact_id}`)}
      >
        <ContactAvatar
          name={person.name}
          photoUrl={person.photo_url}
          className="w-12 h-12 text-sm shrink-0"
          ringClassName={person.network_status === "prospect" ? "ring-teal-500 ring-offset-2" : ""}
        />

        {/* Name + badges + title */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-on-surface truncate">{person.name}</span>
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
            {person.stage && person.stage !== "not_contacted" && (
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${STAGE_STYLES[person.stage]}`}>
                {STAGE_LABELS[person.stage]}
              </span>
            )}
            {isFormer && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-container text-on-surface-variant border border-outline-variant/40">
                Former
              </span>
            )}
          </div>
          <p className="text-xs text-on-surface-variant truncate mt-0.5">
            {role?.title ?? person.headline ?? ""}
            {showLocation && locationSuffix && <span className="xl:hidden"> · {locationSuffix}</span>}
          </p>
        </div>

        {/* Email + location column — appears from xl, vertically aligned
            across cards via fixed clamp width (contacts-list pattern) */}
        <div className="hidden xl:flex flex-col gap-0.5 w-[clamp(120px,12vw,200px)] shrink-0">
          {person.email && (
            <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant min-w-0">
              <Mail className="w-3 h-3 shrink-0" />
              <span className="truncate">{person.email.address}</span>
            </span>
          )}
          {locationSuffix && (
            <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant min-w-0">
              <MapPin className="w-3 h-3 shrink-0" />
              <span className="truncate">{locationSuffix}</span>
            </span>
          )}
        </div>

        <div onClick={(e) => e.stopPropagation()}>
          <ContactEmailAction person={person} gmailConnected={gmailConnected} onCompose={onCompose} />
        </div>

        <TierMoves person={person} onSetTier={onSetTier} />

        {/* Quick-preview chevron — stops propagation so row click navigates */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="group p-1 rounded-full text-on-surface-variant hover:text-on-surface shrink-0 transition-colors"
          title="Quick preview"
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90 group-hover:rotate-0"}`}
          />
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-outline-variant/30">
          <div className="pt-2.5 space-y-2">
            {(person.email || person.linkedin_url) && (
              <div className="flex flex-wrap gap-1.5">
                {person.email && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-on-surface bg-surface-container-high/60 px-2 py-1 rounded-md">
                    <Mail className="w-3 h-3 text-on-surface-variant" /> {person.email.address}
                    {person.email.source === "pattern_guessed" && !person.email.bounced && (
                      <span className="text-yellow-700 text-[10px]">·guessed</span>
                    )}
                    {person.email.bounced && <span className="text-error text-[10px]">·bounced</span>}
                  </span>
                )}
                {person.linkedin_url && (
                  <a
                    href={person.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-primary bg-surface-container-high/60 px-2 py-1 rounded-md hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" /> LinkedIn
                  </a>
                )}
              </div>
            )}

            {person.roles.length > 0 && (
              <div className="space-y-0.5">
                {person.roles.map((r) => (
                  <p key={r.id} className="text-xs text-on-surface-variant">
                    <Briefcase className="w-3 h-3 inline mr-1" />
                    {r.title ?? "Role"}
                    {formatRoleLocationInList(r) && <> · {formatRoleLocationInList(r)}</>}
                    {r.workplace_type === "remote" && <> · Remote</>}
                    {r.start_month && (
                      <> · {r.start_month} – {r.is_current ? "Present" : r.end_month ?? ""}</>
                    )}
                    {r.is_current && <span className="text-primary font-medium ml-1">· Current</span>}
                  </p>
                ))}
              </div>
            )}

            {person.headline && (
              <p className="text-xs text-on-surface-variant">{person.headline}</p>
            )}

            {whySelected && (
              <p className="text-xs text-on-surface-variant italic border-l-2 border-outline-variant/50 pl-2">
                {whySelected}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <Button size="sm" variant="tonal" onClick={() => router.push(`/contacts/${person.contact_id}`)}>
                View full profile
              </Button>
              {stale && <span className="text-[10px] text-on-surface-variant/70">{stale}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactGroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
        {label}
      </p>
      <span className="text-[11px] text-on-surface-variant/70 tabular-nums">{count}</span>
      <div className="flex-1 h-px bg-outline-variant/25" />
    </div>
  );
}

function BenchSection({
  bench,
  jobChangeIds,
  onSetTier,
}: {
  bench: CompanyPerson[];
  /** Bench contacts with an unactioned job-change event (plan 29 Q5 hint). */
  jobChangeIds: Set<number>;
  onSetTier: (person: CompanyPerson, tier: ContactTier) => void;
}) {
  const [open, setOpen] = useState(false);
  if (bench.length === 0) return null;

  const jobChangeCount = bench.filter((p) => jobChangeIds.has(p.contact_id)).length;

  return (
    <div className="mt-4 pt-3 border-t border-outline-variant/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant hover:text-on-surface py-1"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {open ? `${bench.length} archived` : `${bench.length} archived (hidden from list)`}
        {jobChangeCount > 0 && (
          <span className="text-amber-600 font-medium">· {jobChangeCount} just changed jobs</span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 mt-1.5">
          {bench.map((p) => (
            <div
              key={p.contact_id}
              className="flex items-center gap-3 py-2 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors"
            >
              <ContactAvatar
                name={p.name}
                photoUrl={p.photo_url}
                className="w-8 h-8 text-xs shrink-0 grayscale opacity-75"
                ringClassName="ring-outline ring-offset-2"
              />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/contacts/${p.contact_id}`}
                  className="text-sm font-medium text-on-surface hover:text-primary truncate block"
                >
                  {p.name}
                </Link>
                <p className="text-xs text-on-surface-variant truncate">
                  {p.roles[0]?.title ?? p.headline ?? ""}
                </p>
              </div>
              {jobChangeIds.has(p.contact_id) && (
                <Tooltip label="A recent scrape detected a job change — consider promoting to outreach">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-700 bg-amber-100 shrink-0">
                    Just changed jobs
                  </span>
                </Tooltip>
              )}
              {p.adjacency_score != null && (
                <span className="text-[10px] text-on-surface-variant shrink-0" title="Pipeline adjacency score">
                  adj {p.adjacency_score}
                </span>
              )}
              <TierMoves person={p} onSetTier={onSetTier} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecruitingPanel({
  userId,
  scopeLabel,
  isCompanyScope,
  targeted,
  onTargetChange,
  block,
  people,
  scopeState,
  cycleForm,
  onSelectStage,
  onPatchCycle,
  onSetActiveCycle,
  onStartNextCycle,
  onDeleteCycle,
}: {
  userId: string;
  scopeLabel: string;
  isCompanyScope: boolean;
  targeted: boolean;
  onTargetChange: (targeted: boolean) => void;
  block: LocationBlock | null;
  people: CompanyPerson[];
  scopeState: ReturnType<typeof getScopeState>;
  cycleForm: CycleFormState;
  onSelectStage: (stage: PipelineStage) => void;
  onPatchCycle: (patch: (prev: CycleFormState) => CycleFormState) => void;
  onSetActiveCycle: (cycle: number) => void;
  onStartNextCycle: () => void;
  onDeleteCycle: (cycle: number) => void;
}) {
  const outreachContacts = people.filter(
    (p) => p.stage && p.stage !== "not_contacted" && p.stage !== "bounced",
  );

  const progressStage = cycleForm.selectedStage;
  const [expandedStage, setExpandedStage] = useState<PipelineStage>(progressStage);

  useEffect(() => {
    setExpandedStage(progressStage);
  }, [scopeState.activeCycle, progressStage]);

  const handleStageClick = (stage: PipelineStage) => {
    const clickedIndex = stageIndex(stage);
    const progressIndex = stageIndex(progressStage);
    if (clickedIndex > progressIndex) {
      onSelectStage(stage);
    }
    setExpandedStage(stage);
  };

  return (
    <div className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-4 space-y-4">
        <FieldRow label={isCompanyScope ? "Company status" : "Location status"}>
          <Select
            value={targeted ? "target" : "none"}
            onChange={(v) => onTargetChange(v === "target")}
            options={
              targeted
                ? [
                    { value: "target", label: isCompanyScope ? "Target company" : `Target · ${scopeLabel}` },
                    { value: "none", label: "Not a target" },
                  ]
                : [
                    { value: "none", label: "Not a target" },
                    {
                      value: "target",
                      label: isCompanyScope ? "Target company" : `Target · ${scopeLabel}`,
                    },
                  ]
            }
            className="[&_button]:h-10 [&_button]:text-sm"
          />
        </FieldRow>

        {!targeted ? (
          <>
            <div className="rounded-lg border border-dashed border-outline-variant/50 p-4 text-center space-y-2">
              <Target className="w-5 h-5 mx-auto text-on-surface-variant opacity-60" />
              <p className="text-sm text-on-surface-variant">
                {isCompanyScope
                  ? "Mark as a target to track your recruiting pipeline here."
                  : `Target ${scopeLabel} to track status and notes for this office.`}
              </p>
              <Button size="sm" variant="tonal" onClick={() => onTargetChange(true)}>
                {isCompanyScope ? "Target company" : `Target ${scopeLabel}`}
              </Button>
            </div>

            {/* Pre-target research — saved on the scope's container row and
                carried into the pipeline untouched if this becomes a target. */}
            <div className="rounded-lg border border-outline-variant/40 p-3 space-y-3">
              <FieldRow label="Programs">
                <ResearchingProgramsEditor
                  programs={cycleForm.researching.programs}
                  onChange={(programs) =>
                    onPatchCycle((prev) => ({
                      ...prev,
                      researching: { ...prev.researching, programs },
                    }))
                  }
                />
              </FieldRow>
              <FieldRow label="Notes">
                <ResearchingNotesEditor
                  notes={cycleForm.researching.notes}
                  onChange={(notes) =>
                    onPatchCycle((prev) => ({
                      ...prev,
                      researching: { ...prev.researching, notes },
                    }))
                  }
                  intelNotes={block?.notes}
                />
              </FieldRow>
              <p className="text-[11px] text-on-surface-variant/70">
                Research is saved even without targeting — it carries into the pipeline if you
                target {isCompanyScope ? "this company" : scopeLabel} later.
              </p>
            </div>
          </>
        ) : (
          <>
            {scopeState.cycleCount > 1 && (
              <div className="flex gap-1 p-1 rounded-lg bg-surface-container-high/80">
                {Array.from({ length: scopeState.cycleCount }, (_, i) => i + 1).map((c) => (
                  <CycleTab
                    key={c}
                    cycle={c}
                    active={scopeState.activeCycle === c}
                    onSelect={() => onSetActiveCycle(c)}
                    onDelete={() => onDeleteCycle(c)}
                  />
                ))}
              </div>
            )}

            <PipelineStepList
              progressStage={progressStage}
              expandedStage={expandedStage}
              onStageClick={handleStageClick}
              renderStageSummary={(stage) => (
                <StageSummary
                  stage={stage}
                  cycleForm={cycleForm}
                  isCompanyScope={isCompanyScope}
                  scopeLabel={scopeLabel}
                  outreachContacts={outreachContacts}
                />
              )}
              renderStageContent={(stage) => (
                <StageFormFields
                  stage={stage}
                  cycleForm={cycleForm}
                  userId={userId}
                  isCompanyScope={isCompanyScope}
                  scopeLabel={scopeLabel}
                  outreachContacts={outreachContacts}
                  block={block}
                  onPatchCycle={onPatchCycle}
                  onStartNextCycle={onStartNextCycle}
                />
              )}
            />
          </>
        )}
    </div>
  );
}

export function PipelineLayout({
  userId,
  companyId,
  tabs,
  companyName,
  totalContacts,
  linkedinUrl,
  offices,
  state,
  actions,
  saveStatus,
  scope,
  onScopeChange,
  gmailConnected,
  onCompose,
  onSetTier,
  jobChangeIds,
  onOfficesChanged,
}: {
  userId: string;
  companyId: number;
  tabs: LocationTabsData;
  companyName: string;
  totalContacts: number;
  linkedinUrl: string | null;
  offices: CompanyOffice[];
  state: PipelineState;
  actions: PipelineActions;
  saveStatus: PipelineSaveStatus;
  scope: string;
  onScopeChange: (scopeKey: string) => void;
  gmailConnected: boolean;
  onCompose: (opts: { to: string; name: string; contactId: number }) => void;
  onSetTier: (person: CompanyPerson, tier: ContactTier) => void;
  /** Bench contacts with an unactioned job-change event (plan 29 Q5 hint). */
  jobChangeIds: Set<number>;
  onOfficesChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [manageOffices, setManageOffices] = useState(false);

  const { companyTargeted, officeTargeted } = state;
  const scopeState = getScopeState(state, scope);
  const cycleForm = getActiveCycleState(state, scope);

  const scopeOptions = useMemo(() => {
    const opts = [{ value: "all", label: `All · ${tabs.all.contactCount} contacts` }];
    for (const o of tabs.offices) {
      const targeted = officeTargeted[o.key] ?? o.isTargeted;
      opts.push({
        value: o.key,
        label: `${o.tabLabel} · ${o.contactCount}${targeted ? " · targeted" : ""}`,
      });
    }
    return opts;
  }, [tabs, officeTargeted]);

  const isCompanyScope = scope === "all";
  const officeBlock = tabs.offices.find((o) => o.key === scope) ?? null;

  const peopleBlock = isCompanyScope ? tabs.all : officeBlock ?? tabs.all;
  const showLocationOnContacts = isCompanyScope;

  const formerIds = useMemo(
    () => new Set(peopleBlock.former.map((p) => p.contact_id)),
    [peopleBlock],
  );

  const filteredPeople = useMemo(() => {
    const all = [...peopleBlock.current, ...peopleBlock.former];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.roles[0]?.title ?? p.headline ?? "").toLowerCase().includes(q),
    );
  }, [peopleBlock, search]);

  // Tier separation — the avatar rings only read correctly when network
  // contacts and prospects live in distinct groups (matches /contacts).
  const networkPeople = useMemo(
    () => filteredPeople.filter((p) => p.network_status === "active"),
    [filteredPeople],
  );
  const prospectPeople = useMemo(
    () => filteredPeople.filter((p) => p.network_status !== "active"),
    [filteredPeople],
  );

  const targeted = isCompanyScope
    ? companyTargeted
    : (officeTargeted[scope] ?? officeBlock?.isTargeted ?? false);

  const recruitingBlock: LocationBlock | null = isCompanyScope
    ? tabs.companyWide ??
      (companyTargeted
        ? {
            key: "company",
            label: "Company-wide",
            tabLabel: "Company",
            location_id: null,
            contactCount: 0,
            isTargeted: true,
            status: cycleForm.selectedStage,
            next_app_date: null,
            app_window_text: null,
            notes: [],
            current: [],
            former: [],
            bench: [],
          }
        : null)
    : officeBlock
      ? { ...officeBlock, isTargeted: targeted, status: cycleForm.selectedStage }
      : null;

  const scopeLabel = isCompanyScope ? "Company-wide" : (officeBlock?.tabLabel ?? scope);
  const saveLabel = SAVE_STATUS_LABELS[saveStatus];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-on-surface">{companyName}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-on-surface-variant flex-wrap">
            <span>
              {totalContacts} contact{totalContacts === 1 ? "" : "s"}
            </span>
            {linkedinUrl && (
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary"
              >
                LinkedIn
              </a>
            )}
            {saveLabel && (
              <span
                className={`text-xs ${saveStatus === "error" ? "text-error" : "text-on-surface-variant/70"}`}
                aria-live="polite"
              >
                {saveLabel}
              </span>
            )}
          </div>
        </div>
        <div className="w-full sm:w-56 shrink-0">
          <FieldRow label="Location">
            <Select
              value={scope}
              onChange={onScopeChange}
              options={scopeOptions}
              className="[&_button]:h-10 [&_button]:text-sm"
            />
          </FieldRow>
          <button
            type="button"
            onClick={() => setManageOffices((v) => !v)}
            className="mt-1.5 text-xs text-on-surface-variant hover:text-on-surface underline-offset-2 hover:underline"
          >
            {manageOffices ? "Close office management" : "Manage offices"}
          </button>
        </div>
      </div>

      {manageOffices && (
        <div className="mb-6">
          <ManageOfficesPanel companyId={companyId} offices={offices} onChanged={onOfficesChanged} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(440px,560px)] gap-6 items-start">
        <div className="min-w-0 space-y-6">
        {/* Discovery candidates (plan 41) — absent unless the weekly search found someone */}
        <DiscoveryCard companyId={companyId} />
        <section className="min-w-0 rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-4">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-sm font-medium text-on-surface">Contacts</h2>
            <span className="text-xs text-on-surface-variant tabular-nums">{filteredPeople.length}</span>
          </div>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts"
              className="w-full h-10 pl-9 pr-3 rounded-lg border border-outline-variant/50 bg-surface-container-high/40 text-sm text-on-surface placeholder:text-on-surface-variant/60"
            />
          </div>
          {filteredPeople.length === 0 ? (
            <p className="text-sm text-on-surface-variant py-8 text-center">
              {search.trim() ? "No contacts match." : "No contacts at this office yet."}
            </p>
          ) : (
            <div className="space-y-2">
              {[
                { label: "Your network", people: networkPeople },
                { label: "Prospects", people: prospectPeople },
              ].map(
                ({ label, people }) =>
                  people.length > 0 && (
                    <div key={label} className="space-y-2">
                      <ContactGroupHeading label={label} count={people.length} />
                      {people.map((p) => (
                        <ContactRow
                          key={p.contact_id}
                          person={p}
                          isFormer={formerIds.has(p.contact_id)}
                          showLocation={showLocationOnContacts}
                          gmailConnected={gmailConnected}
                          onCompose={onCompose}
                          onSetTier={onSetTier}
                        />
                      ))}
                    </div>
                  ),
              )}
            </div>
          )}
          <BenchSection bench={peopleBlock.bench} jobChangeIds={jobChangeIds} onSetTier={onSetTier} />
        </section>
        </div>

        <RecruitingPanel
          userId={userId}
          scopeLabel={scopeLabel}
          isCompanyScope={isCompanyScope}
          targeted={targeted}
          onTargetChange={(v) => actions.setScopeTargeted(scope, v)}
          block={recruitingBlock}
          people={filteredPeople}
          scopeState={scopeState}
          cycleForm={cycleForm}
          onSelectStage={(stage) => actions.selectStage(scope, stage)}
          onPatchCycle={(patch) => actions.patchActiveCycle(scope, patch)}
          onSetActiveCycle={(cycle) => actions.setActiveCycle(scope, cycle)}
          onStartNextCycle={() => actions.startNextCycle(scope)}
          onDeleteCycle={(cycle) => actions.deleteCycle(scope, cycle)}
        />
      </div>
    </div>
  );
}
