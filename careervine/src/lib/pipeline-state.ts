/**
 * Client-side state model for the company recruiting pipeline (CAR-6).
 *
 * The company page keeps one pipeline per scope — "all" (company-wide)
 * plus one per office — each with numbered application cycles. This
 * module owns the state shape, defaults, normalization, and pure patch
 * helpers; persistence lives in pipeline-queries.ts (Supabase), which
 * replaced the preview-era localStorage/IndexedDB storage.
 */

import type { LocationTabsData } from "@/lib/company-scopes";
import type { CompanyDetail } from "@/lib/company-queries";

export const PIPELINE_STAGES = [
  "researching",
  "outreach_active",
  "applied",
  "interviewing",
  "closed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Reference to an uploaded PDF in the application-files storage bucket. */
export interface PipelineFileRef {
  path: string;
  name: string;
  sizeBytes: number;
}

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
  resume: PipelineFileRef | null;
  coverLetter: PipelineFileRef | null;
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

export interface PipelineState {
  companyTargeted: boolean;
  officeTargeted: Record<string, boolean>;
  scopes: Record<string, ScopePipelineState>;
}

export function createPipelineEntityId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // uuid-shaped fallback so Postgres uuid columns still accept it
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

export const createResearchingNoteId = createPipelineEntityId;
export const createResearchingProgramId = createPipelineEntityId;
export const createJobApplicationId = createPipelineEntityId;
export const createInterviewRoundId = createPipelineEntityId;

// ── Normalization ──────────────────────────────────────────────────────

function normalizeFileRef(ref: unknown): PipelineFileRef | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as Partial<PipelineFileRef>;
  if (typeof r.path !== "string" || !r.path) return null;
  return {
    path: r.path,
    name: typeof r.name === "string" && r.name ? r.name : "document.pdf",
    sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
  };
}

function normalizeResearching(researching: Partial<CycleFormState["researching"]> | undefined): CycleFormState["researching"] {
  const programs = Array.isArray(researching?.programs)
    ? researching.programs.map((p) => ({
        id: typeof p.id === "string" && p.id ? p.id : createResearchingProgramId(),
        name: p.name ?? "",
        appsOpen: p.appsOpen ?? "",
        jobPotential: p.jobPotential ?? "",
      }))
    : [];
  const notes = Array.isArray(researching?.notes)
    ? researching.notes
        .filter((n) => n && typeof n.body === "string" && n.body.trim())
        .map((n) => ({
          id: typeof n.id === "string" && n.id ? n.id : createResearchingNoteId(),
          body: n.body.trim(),
        }))
    : [];
  return { programs, notes };
}

function normalizeApplied(applied: Partial<CycleFormState["applied"]> | undefined): CycleFormState["applied"] {
  const applications = Array.isArray(applied?.applications)
    ? applied.applications.map((a) => ({
        id: typeof a.id === "string" && a.id ? a.id : createJobApplicationId(),
        jobTitle: a.jobTitle ?? "",
        location: a.location ?? "",
        dateApplied: a.dateApplied ?? "",
        resume: normalizeFileRef(a.resume),
        coverLetter: normalizeFileRef(a.coverLetter),
      }))
    : [];
  return { applications };
}

function normalizeInterviewing(interviewing: Partial<CycleFormState["interviewing"]> | undefined): CycleFormState["interviewing"] {
  const rounds = Array.isArray(interviewing?.rounds)
    ? interviewing.rounds.map((round) => ({
        id: typeof round.id === "string" && round.id ? round.id : createInterviewRoundId(),
        date: round.date ?? "",
        interviewer: round.interviewer ?? "",
        questions: round.questions ?? "",
      }))
    : [];
  return { rounds };
}

export function normalizeCycleFormState(cycle: Partial<CycleFormState>): CycleFormState {
  const stage = cycle.selectedStage;
  return {
    selectedStage: stage && PIPELINE_STAGES.includes(stage) ? stage : "researching",
    researching: normalizeResearching(cycle.researching),
    applied: normalizeApplied(cycle.applied),
    interviewing: normalizeInterviewing(cycle.interviewing),
    closed: { declinedNextCycle: Boolean(cycle.closed?.declinedNextCycle) },
  };
}

// ── Defaults ───────────────────────────────────────────────────────────

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

/** Seed hints for a scope's first cycle from its target row. */
export function cycleHintsFromTarget(
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

export function defaultPipelineState(
  tabs: LocationTabsData,
  target: CompanyDetail["target"],
): PipelineState {
  const officeTargeted = Object.fromEntries(tabs.offices.map((o) => [o.key, o.isTargeted]));
  const companyHints = cycleHintsFromTarget(target, tabs.companyWide?.status ?? null);

  return {
    companyTargeted: Boolean(tabs.companyWide?.isTargeted),
    officeTargeted,
    scopes: {
      all: defaultScopePipelineState(companyHints),
    },
  };
}

/**
 * Fill in scopes/targeting for offices the state doesn't know yet
 * (e.g. a new office appeared since the pipeline was persisted).
 */
export function mergePipelineState(state: PipelineState, tabs: LocationTabsData): PipelineState {
  const officeTargeted = { ...state.officeTargeted };
  for (const o of tabs.offices) {
    if (!(o.key in officeTargeted)) officeTargeted[o.key] = o.isTargeted;
  }

  const scopes = { ...state.scopes };
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

  return { ...state, officeTargeted, scopes };
}

// ── Pure state patches ─────────────────────────────────────────────────

export function getScopeState(state: PipelineState, scopeKey: string): ScopePipelineState {
  return state.scopes[scopeKey] ?? defaultScopePipelineState();
}

export function getActiveCycleState(state: PipelineState, scopeKey: string): CycleFormState {
  const scope = getScopeState(state, scopeKey);
  const key = String(scope.activeCycle);
  const cycle = scope.cycles[key] ?? defaultCycleFormState();
  return normalizeCycleFormState(cycle);
}

export function patchPipelineState(
  state: PipelineState,
  patch: Partial<PipelineState>,
): PipelineState {
  return { ...state, ...patch };
}

export function patchScopeState(
  state: PipelineState,
  scopeKey: string,
  patch: Partial<ScopePipelineState>,
): PipelineState {
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
  state: PipelineState,
  scopeKey: string,
  cycle: number,
  patch: Partial<CycleFormState> | ((prev: CycleFormState) => CycleFormState),
): PipelineState {
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
  state: PipelineState,
  scopeKey: string,
  cycleToDelete: number,
): PipelineState {
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
