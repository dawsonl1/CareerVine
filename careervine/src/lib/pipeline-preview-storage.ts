import type { LocationTabsData } from "@/lib/company-location-preview";
import type { CompanyDetail } from "@/lib/company-queries";

export const PIPELINE_PREVIEW_STORAGE_VERSION = 1 as const;

export const PIPELINE_STAGES = [
  "researching",
  "outreach_active",
  "applied",
  "interviewing",
  "closed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface PipelineResearchingNote {
  id: string;
  body: string;
}

export interface PipelineResearchingProgram {
  id: string;
  name: string;
  appsOpen: string;
  jobPotential: string;
}

export interface PipelineJobApplication {
  id: string;
  jobTitle: string;
  location: string;
  dateApplied: string;
  resumeFileId: string | null;
  coverLetterFileId: string | null;
}

export interface PipelineInterviewRound {
  id: string;
  date: string;
  interviewer: string;
  questions: string;
}

export interface CycleFormState {
  selectedStage: PipelineStage;
  researching: {
    programs: PipelineResearchingProgram[];
    notes: PipelineResearchingNote[];
  };
  applied: {
    applications: PipelineJobApplication[];
  };
  interviewing: {
    rounds: PipelineInterviewRound[];
  };
  closed: {
    declinedNextCycle: boolean;
  };
}

export interface ScopePipelineState {
  cycleCount: number;
  activeCycle: number;
  cycles: Record<string, CycleFormState>;
}

export type PipelineMainTab = "contacts" | "recruiting";

export interface PipelinePreviewState {
  version: typeof PIPELINE_PREVIEW_STORAGE_VERSION;
  scope: string;
  search: string;
  mainTab: PipelineMainTab;
  companyTargeted: boolean;
  officeTargeted: Record<string, boolean>;
  scopes: Record<string, ScopePipelineState>;
}

export function pipelinePreviewStorageKey(companyId: number): string {
  return `cv:pipeline-preview:v${PIPELINE_PREVIEW_STORAGE_VERSION}:${companyId}`;
}

export function createResearchingNoteId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createResearchingProgramId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `program-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createJobApplicationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `application-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createInterviewRoundId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `round-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type ResearchingRaw = CycleFormState["researching"] & {
  note?: string;
  appsOpen?: string;
  jobPotential?: string;
  program?: string;
};

function normalizeResearchingNotes(notes: unknown, legacyNote?: string): PipelineResearchingNote[] {
  if (Array.isArray(notes)) {
    return notes
      .filter((n) => n && typeof n.body === "string" && n.body.trim())
      .map((n) => ({
        id: typeof n.id === "string" && n.id ? n.id : createResearchingNoteId(),
        body: n.body.trim(),
      }));
  }
  const legacy = typeof legacyNote === "string" ? legacyNote.trim() : "";
  return legacy ? [{ id: createResearchingNoteId(), body: legacy }] : [];
}

function normalizeResearchingPrograms(researching: ResearchingRaw): PipelineResearchingProgram[] {
  if (Array.isArray(researching.programs)) {
    return researching.programs.map((p) => ({
      id: typeof p.id === "string" && p.id ? p.id : createResearchingProgramId(),
      name: p.name ?? "",
      appsOpen: p.appsOpen ?? "",
      jobPotential: p.jobPotential ?? "",
    }));
  }

  const hasLegacy =
    (researching.program ?? "").trim() ||
    (researching.appsOpen ?? "").trim() ||
    (researching.jobPotential ?? "").trim();

  if (!hasLegacy) return [];

  return [
    {
      id: createResearchingProgramId(),
      name: researching.program ?? "",
      appsOpen: researching.appsOpen ?? "",
      jobPotential: researching.jobPotential ?? "",
    },
  ];
}

function normalizeResearching(researching: ResearchingRaw): CycleFormState["researching"] {
  return {
    programs: normalizeResearchingPrograms(researching),
    notes: normalizeResearchingNotes(researching.notes, researching.note),
  };
}

type AppliedRaw = CycleFormState["applied"] & {
  resume?: string;
  coverLetter?: string;
  dateApplied?: string;
  locations?: string[];
};

function normalizeAppliedApplications(applied: AppliedRaw): PipelineJobApplication[] {
  if (Array.isArray(applied.applications)) {
    return applied.applications.map((a) => ({
      id: typeof a.id === "string" && a.id ? a.id : createJobApplicationId(),
      jobTitle: a.jobTitle ?? "",
      location: a.location ?? "",
      dateApplied: a.dateApplied ?? "",
      resumeFileId: a.resumeFileId ?? null,
      coverLetterFileId: a.coverLetterFileId ?? null,
    }));
  }

  const locations = Array.isArray(applied.locations)
    ? applied.locations.map((l) => (typeof l === "string" ? l.trim() : "")).filter(Boolean)
    : [];
  const dateApplied = typeof applied.dateApplied === "string" ? applied.dateApplied : "";
  const hasLegacyText =
    (typeof applied.resume === "string" && applied.resume.trim()) ||
    (typeof applied.coverLetter === "string" && applied.coverLetter.trim()) ||
    dateApplied.trim() ||
    locations.length > 0;

  if (!hasLegacyText) return [];

  if (locations.length > 0) {
    return locations.map((location) => ({
      id: createJobApplicationId(),
      jobTitle: "",
      location,
      dateApplied,
      resumeFileId: null,
      coverLetterFileId: null,
    }));
  }

  return [
    {
      id: createJobApplicationId(),
      jobTitle: "",
      location: "",
      dateApplied,
      resumeFileId: null,
      coverLetterFileId: null,
    },
  ];
}

function normalizeApplied(applied: AppliedRaw): CycleFormState["applied"] {
  return { applications: normalizeAppliedApplications(applied) };
}

function interviewRoundHasContent(round: {
  date?: string;
  interviewer?: string;
  questions?: string;
}): boolean {
  return Boolean(
    (round.date ?? "").trim() ||
      (round.interviewer ?? "").trim() ||
      (round.questions ?? "").trim(),
  );
}

function isLegacyDefaultInterviewRounds(
  rounds: Array<{ date?: string; interviewer?: string; questions?: string }>,
): boolean {
  return rounds.length === 2 && rounds.every((round) => !interviewRoundHasContent(round));
}

function normalizeInterviewRounds(rounds: unknown): PipelineInterviewRound[] {
  if (!Array.isArray(rounds)) return [];
  if (isLegacyDefaultInterviewRounds(rounds)) return [];

  return rounds.map((round) => ({
    id: typeof round.id === "string" && round.id ? round.id : createInterviewRoundId(),
    date: round.date ?? "",
    interviewer: round.interviewer ?? "",
    questions: round.questions ?? "",
  }));
}

function normalizeInterviewing(interviewing: CycleFormState["interviewing"]): CycleFormState["interviewing"] {
  return { rounds: normalizeInterviewRounds(interviewing.rounds) };
}

function normalizeClosed(closed: CycleFormState["closed"] | undefined): CycleFormState["closed"] {
  return { declinedNextCycle: Boolean(closed?.declinedNextCycle) };
}

export function normalizeCycleFormState(cycle: CycleFormState): CycleFormState {
  return {
    ...cycle,
    researching: normalizeResearching(cycle.researching as ResearchingRaw),
    applied: normalizeApplied(cycle.applied as AppliedRaw),
    interviewing: normalizeInterviewing(cycle.interviewing),
    closed: normalizeClosed(cycle.closed),
  };
}

export function defaultCycleFormState(hints?: {
  selectedStage?: PipelineStage;
  programs?: PipelineResearchingProgram[];
  appsOpen?: string;
  jobPotential?: string;
  program?: string;
}): CycleFormState {
  const programs =
    hints?.programs ??
    (hints?.program?.trim() || hints?.appsOpen?.trim() || hints?.jobPotential?.trim()
      ? [
          {
            id: createResearchingProgramId(),
            name: hints.program ?? "",
            appsOpen: hints.appsOpen ?? "",
            jobPotential: hints.jobPotential ?? "",
          },
        ]
      : []);

  return {
    selectedStage: hints?.selectedStage ?? "researching",
    researching: {
      programs,
      notes: [],
    },
    applied: {
      applications: [],
    },
    interviewing: {
      rounds: [],
    },
    closed: {
      declinedNextCycle: false,
    },
  };
}

export function defaultScopePipelineState(hints?: Parameters<typeof defaultCycleFormState>[0]): ScopePipelineState {
  return {
    cycleCount: 1,
    activeCycle: 1,
    cycles: { "1": defaultCycleFormState(hints) },
  };
}

export function defaultPipelinePreviewState(
  tabs: LocationTabsData,
  target: CompanyDetail["target"],
): PipelinePreviewState {
  const officeTargeted = Object.fromEntries(tabs.offices.map((o) => [o.key, o.isTargeted]));
  const companyHints = cycleHintsFromTarget(target, tabs.companyWide?.status ?? null);

  return {
    version: PIPELINE_PREVIEW_STORAGE_VERSION,
    scope: "all",
    search: "",
    mainTab: "contacts",
    companyTargeted: Boolean(tabs.companyWide?.isTargeted),
    officeTargeted,
    scopes: {
      all: defaultScopePipelineState(companyHints),
    },
  };
}

function cycleHintsFromTarget(
  target: CompanyDetail["target"],
  status: string | null,
): Parameters<typeof defaultCycleFormState>[0] {
  const selectedStage = PIPELINE_STAGES.includes(status as PipelineStage)
    ? (status as PipelineStage)
    : "researching";
  const appsOpen = target?.next_app_date
    ? `date:${target.next_app_date}`
    : target?.app_window_text ?? "";

  return {
    selectedStage,
    appsOpen,
    jobPotential: target?.priority_score != null ? String(target.priority_score) : "",
    program: target?.program_name ?? "",
  };
}

export function loadPipelinePreviewState(companyId: number): PipelinePreviewState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(pipelinePreviewStorageKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PipelinePreviewState;
    if (parsed?.version !== PIPELINE_PREVIEW_STORAGE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePipelinePreviewState(companyId: number, state: PipelinePreviewState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(pipelinePreviewStorageKey(companyId), JSON.stringify(state));
  } catch {
    // quota / private mode — ignore
  }
}

export function mergePipelinePreviewState(
  saved: PipelinePreviewState,
  tabs: LocationTabsData,
): PipelinePreviewState {
  const officeTargeted = { ...saved.officeTargeted };
  for (const o of tabs.offices) {
    if (!(o.key in officeTargeted)) officeTargeted[o.key] = o.isTargeted;
  }

  const scopes = { ...saved.scopes };
  if (!scopes.all) {
    scopes.all = defaultScopePipelineState();
  }

  for (const o of tabs.offices) {
    if (!scopes[o.key]) {
      const status = o.isTargeted ? (o.status as PipelineStage | null) : null;
      scopes[o.key] = defaultScopePipelineState({
        selectedStage:
          status && PIPELINE_STAGES.includes(status) ? status : "researching",
      });
    }
  }

  const validScopes = new Set(["all", ...tabs.offices.map((o) => o.key)]);
  const scope = validScopes.has(saved.scope) ? saved.scope : "all";

  return {
    ...saved,
    scope,
    mainTab: saved.mainTab === "recruiting" ? "recruiting" : "contacts",
    officeTargeted,
    scopes,
  };
}

export function getScopeState(state: PipelinePreviewState, scopeKey: string): ScopePipelineState {
  return state.scopes[scopeKey] ?? defaultScopePipelineState();
}

export function getActiveCycleState(state: PipelinePreviewState, scopeKey: string): CycleFormState {
  const scope = getScopeState(state, scopeKey);
  const key = String(scope.activeCycle);
  const cycle = scope.cycles[key] ?? defaultCycleFormState();
  return normalizeCycleFormState(cycle);
}

export function patchPipelinePreviewState(
  state: PipelinePreviewState,
  patch: Partial<PipelinePreviewState>,
): PipelinePreviewState {
  return { ...state, ...patch };
}

export function patchScopeState(
  state: PipelinePreviewState,
  scopeKey: string,
  patch: Partial<ScopePipelineState>,
): PipelinePreviewState {
  const prev = getScopeState(state, scopeKey);
  return {
    ...state,
    scopes: {
      ...state.scopes,
      [scopeKey]: { ...prev, ...patch },
    },
  };
}

export function patchCycleFormState(
  state: PipelinePreviewState,
  scopeKey: string,
  cycle: number,
  patch: Partial<CycleFormState> | ((prev: CycleFormState) => CycleFormState),
): PipelinePreviewState {
  const scope = getScopeState(state, scopeKey);
  const key = String(cycle);
  const prev = scope.cycles[key] ?? defaultCycleFormState();
  const next = normalizeCycleFormState(
    typeof patch === "function" ? patch(normalizeCycleFormState(prev)) : { ...prev, ...patch },
  );

  return patchScopeState(state, scopeKey, {
    cycles: { ...scope.cycles, [key]: next },
  });
}

export function deleteScopeCycle(
  state: PipelinePreviewState,
  scopeKey: string,
  cycleToDelete: number,
): PipelinePreviewState {
  const scope = getScopeState(state, scopeKey);
  if (scope.cycleCount <= 1) return state;
  if (cycleToDelete < 1 || cycleToDelete > scope.cycleCount) return state;

  const remainingCycles: CycleFormState[] = [];
  for (let cycle = 1; cycle <= scope.cycleCount; cycle++) {
    if (cycle === cycleToDelete) continue;
    const key = String(cycle);
    remainingCycles.push(normalizeCycleFormState(scope.cycles[key] ?? defaultCycleFormState()));
  }

  const cycles: Record<string, CycleFormState> = {};
  remainingCycles.forEach((cycle, index) => {
    cycles[String(index + 1)] = cycle;
  });

  const cycleCount = scope.cycleCount - 1;
  let activeCycle = scope.activeCycle;
  if (cycleToDelete < scope.activeCycle) {
    activeCycle = scope.activeCycle - 1;
  } else if (cycleToDelete === scope.activeCycle) {
    activeCycle = Math.max(1, scope.activeCycle - 1);
  }

  return patchScopeState(state, scopeKey, {
    cycleCount,
    activeCycle,
    cycles,
  });
}
