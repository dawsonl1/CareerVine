"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { LocationTabsData, PreviewLocationBlock } from "@/lib/company-location-preview";
import type { CompanyDetail, CompanyPerson } from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import { formatRoleLocationInList } from "@/lib/location-tab-label";
import {
  PIPELINE_STAGES,
  type CycleFormState,
  type PipelinePreviewState,
  type PipelineStage,
  defaultCycleFormState,
  defaultPipelinePreviewState,
  getActiveCycleState,
  getScopeState,
  loadPipelinePreviewState,
  mergePipelinePreviewState,
  patchCycleFormState,
  patchPipelinePreviewState,
  patchScopeState,
  savePipelinePreviewState,
  deleteScopeCycle,
} from "@/lib/pipeline-preview-storage";
import { Search, Mail, GraduationCap, Target, Check, Trash2 } from "lucide-react";
import { ResearchingNotesEditor } from "@/components/companies/location-first-preview/researching-notes";
import { ResearchingProgramsEditor } from "@/components/companies/location-first-preview/researching-programs";
import { AppliedApplicationsEditor } from "@/components/companies/location-first-preview/applied-applications";
import { InterviewingRoundsEditor } from "@/components/companies/location-first-preview/interviewing-rounds";
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

function stageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
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
  companyId,
  isCompanyScope,
  scopeLabel,
  outreachContacts,
  block,
  onPatchCycle,
  onStartNextCycle,
}: {
  stage: PipelineStage;
  cycleForm: CycleFormState;
  companyId: number;
  isCompanyScope: boolean;
  scopeLabel: string;
  outreachContacts: CompanyPerson[];
  block: PreviewLocationBlock | null;
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
            </li>
          ))}
        </ul>
      );
    case "applied":
      return (
        <FieldRow label="Applications">
          <AppliedApplicationsEditor
            companyId={companyId}
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

function ContactRow({ person, showLocation }: { person: CompanyPerson; showLocation?: boolean }) {
  const role = person.roles[0];
  const locationSuffix = showLocation && role ? formatRoleLocationInList(role) : null;

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg border border-outline-variant/30 bg-surface-container-lowest hover:bg-surface-container-high/50 transition-colors">
      <ContactAvatar name={person.name} photoUrl={person.photo_url} className="w-9 h-9 text-xs shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link
            href={`/contacts/${person.contact_id}`}
            className="text-sm font-medium text-on-surface hover:text-primary truncate"
          >
            {person.name}
          </Link>
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

function RecruitingPanel({
  companyId,
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
  companyId: number;
  scopeLabel: string;
  isCompanyScope: boolean;
  targeted: boolean;
  onTargetChange: (targeted: boolean) => void;
  block: PreviewLocationBlock | null;
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
                  companyId={companyId}
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
  companyId,
  tabs,
  companyName,
  totalContacts,
  linkedinUrl,
  target,
}: {
  companyId: number;
  tabs: LocationTabsData;
  companyName: string;
  totalContacts: number;
  linkedinUrl: string | null;
  target: CompanyDetail["target"];
}) {
  const [hydrated, setHydrated] = useState(false);
  const [preview, setPreview] = useState<PipelinePreviewState>(() =>
    defaultPipelinePreviewState(tabs, target),
  );

  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const saved = loadPipelinePreviewState(companyId);
    setPreview(saved ? mergePipelinePreviewState(saved, tabs) : defaultPipelinePreviewState(tabs, target));
    setHydrated(true);
  }, [companyId, tabs, target]);

  useEffect(() => {
    if (!hydrated) return;
    savePipelinePreviewState(companyId, preview);
  }, [companyId, preview, hydrated]);

  const { scope, search, companyTargeted, officeTargeted } = preview;
  const scopeState = getScopeState(preview, scope);
  const cycleForm = getActiveCycleState(preview, scope);

  const setPreviewPatch = useCallback((patch: Partial<PipelinePreviewState>) => {
    setPreview((prev) => patchPipelinePreviewState(prev, patch));
  }, []);

  const patchCycle = useCallback(
    (patch: (prev: CycleFormState) => CycleFormState) => {
      setPreview((prev) => patchCycleFormState(prev, prev.scope, getScopeState(prev, prev.scope).activeCycle, patch));
    },
    [],
  );

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

  const targeted = isCompanyScope
    ? companyTargeted
    : (officeTargeted[scope] ?? officeBlock?.isTargeted ?? false);

  const recruitingBlock: PreviewLocationBlock | null = isCompanyScope
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

  const handleStartNextCycle = () => {
    setPreview((prev) => {
      const scopeKey = prev.scope;
      const current = getScopeState(prev, scopeKey);
      const nextCycle = current.cycleCount + 1;
      const nextScope = {
        ...current,
        cycleCount: nextCycle,
        activeCycle: nextCycle,
        cycles: {
          ...current.cycles,
          [String(nextCycle)]: defaultCycleFormState({ selectedStage: "researching" }),
        },
      };
      return patchScopeState(prev, scopeKey, nextScope);
    });
  };

  const handleDeleteCycle = (cycle: number) => {
    setPreview((prev) => deleteScopeCycle(prev, prev.scope, cycle));
  };

  if (!hydrated) {
    return <p className="text-sm text-on-surface-variant py-16 text-center">Loading preview…</p>;
  }

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
          </div>
        </div>
        <div className="w-full sm:w-56 shrink-0">
          <FieldRow label="Location">
            <Select
              value={scope}
              onChange={(v) => setPreviewPatch({ scope: v })}
              options={scopeOptions}
              className="[&_button]:h-10 [&_button]:text-sm"
            />
          </FieldRow>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(440px,560px)] gap-6 items-start">
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
              onChange={(e) => setPreviewPatch({ search: e.target.value })}
              placeholder="Search contacts"
              className="w-full h-10 pl-9 pr-3 rounded-lg border border-outline-variant/50 bg-surface-container-high/40 text-sm text-on-surface placeholder:text-on-surface-variant/60"
            />
          </div>
          <div className="space-y-2">
            {filteredPeople.length === 0 ? (
              <p className="text-sm text-on-surface-variant py-8 text-center">No contacts match.</p>
            ) : (
              filteredPeople.map((p) => (
                <ContactRow key={p.contact_id} person={p} showLocation={showLocationOnContacts} />
              ))
            )}
          </div>
          {peopleBlock.bench.length > 0 && (
            <p className="text-xs text-on-surface-variant mt-4 pt-3 border-t border-outline-variant/25">
              {peopleBlock.bench.length} on bench (hidden from list)
            </p>
          )}
        </section>

        <RecruitingPanel
          companyId={companyId}
          scopeLabel={scopeLabel}
          isCompanyScope={isCompanyScope}
          targeted={targeted}
          onTargetChange={(v) => {
            if (isCompanyScope) setPreviewPatch({ companyTargeted: v });
            else setPreviewPatch({ officeTargeted: { ...officeTargeted, [scope]: v } });
          }}
          block={recruitingBlock}
          people={filteredPeople}
          scopeState={scopeState}
          cycleForm={cycleForm}
          onSelectStage={(stage) => patchCycle((prev) => ({ ...prev, selectedStage: stage }))}
          onPatchCycle={patchCycle}
          onSetActiveCycle={(cycle) => {
            setPreview((prev) => patchScopeState(prev, prev.scope, { activeCycle: cycle }));
          }}
          onStartNextCycle={handleStartNextCycle}
          onDeleteCycle={handleDeleteCycle}
        />
      </div>
    </div>
  );
}
