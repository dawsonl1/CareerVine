/**
 * Supabase persistence for the company recruiting pipeline (CAR-6).
 *
 * Scopes map onto target_companies rows: location_id NULL is the
 * company-wide scope (UI key "all"); location_id set is an office scope
 * (UI key String(location_id), matching the location facet keys).
 * Cycle content is written atomically through the save_pipeline_cycle /
 * delete_pipeline_cycle RPCs; un-targeting is a soft is_targeted flip so
 * pipeline data survives.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { Database } from "@/lib/database.types";
import {
  type CycleFormState,
  type PipelineFileRef,
  type PipelineStage,
  type ScopePipelineState,
  PIPELINE_STAGES,
  normalizeCycleFormState,
} from "@/lib/pipeline-state";

type QueryClient = ReturnType<typeof createSupabaseBrowserClient>;

let browserClient: QueryClient | null = null;

function db(): QueryClient {
  if (!browserClient) browserClient = createSupabaseBrowserClient();
  return browserClient;
}

export const APPLICATION_FILES_BUCKET = "application-files";
export const APPLICATION_PDF_MAX_BYTES = 5 * 1024 * 1024;

type TargetRow = Database["public"]["Tables"]["target_companies"]["Row"];
type CycleRow = Database["public"]["Tables"]["pipeline_cycles"]["Row"];
type ProgramRow = Database["public"]["Tables"]["pipeline_programs"]["Row"];
type NoteRow = Database["public"]["Tables"]["pipeline_notes"]["Row"];
type ApplicationRow = Database["public"]["Tables"]["pipeline_applications"]["Row"];
type RoundRow = Database["public"]["Tables"]["pipeline_interview_rounds"]["Row"];

/** UI scope key for a target row: "all" for company-wide, else the location id. */
export function scopeKeyForLocationId(locationId: number | null): string {
  return locationId == null ? "all" : String(locationId);
}

export function locationIdForScopeKey(scopeKey: string): number | null {
  return scopeKey === "all" ? null : Number(scopeKey);
}

export interface PipelineScope {
  targetId: number;
  locationId: number | null;
  isTargeted: boolean;
  status: string;
  scope: ScopePipelineState;
}

/** Everything persisted for one company's pipelines, keyed by scope key. */
export type LoadedPipeline = Map<string, PipelineScope>;

function fileRefFromColumns(
  path: string | null,
  name: string | null,
  sizeBytes: number | null,
): PipelineFileRef | null {
  if (!path) return null;
  return { path, name: name ?? "document.pdf", sizeBytes: sizeBytes ?? 0 };
}

function cycleFormFromRows(
  cycle: CycleRow,
  programs: ProgramRow[],
  notes: NoteRow[],
  applications: ApplicationRow[],
  rounds: RoundRow[],
): CycleFormState {
  return normalizeCycleFormState({
    selectedStage: cycle.selected_stage as PipelineStage,
    researching: {
      programs: programs.map((p) => ({
        id: p.id,
        name: p.name,
        appsOpen: p.apps_open,
        jobPotential: p.job_potential,
      })),
      notes: notes.map((n) => ({ id: n.id, body: n.body })),
    },
    applied: {
      applications: applications.map((a) => ({
        id: a.id,
        jobTitle: a.job_title,
        location: a.location,
        dateApplied: a.date_applied ?? "",
        resume: fileRefFromColumns(a.resume_path, a.resume_name, a.resume_size_bytes),
        coverLetter: fileRefFromColumns(
          a.cover_letter_path,
          a.cover_letter_name,
          a.cover_letter_size_bytes,
        ),
      })),
    },
    interviewing: {
      rounds: rounds.map((r) => ({
        id: r.id,
        date: r.interview_date ?? "",
        interviewer: r.interviewer,
        questions: r.questions,
      })),
    },
    closed: { declinedNextCycle: cycle.declined_next_cycle },
  });
}

export async function loadPipeline(userId: string, companyId: number): Promise<LoadedPipeline> {
  const { data: targetRows, error: targetsError } = await db()
    .from("target_companies")
    .select("id, location_id, is_targeted, active_cycle, status")
    .eq("user_id", userId)
    .eq("company_id", companyId);
  if (targetsError) throw targetsError;

  const targets = (targetRows ?? []) as Pick<
    TargetRow,
    "id" | "location_id" | "is_targeted" | "active_cycle" | "status"
  >[];
  const result: LoadedPipeline = new Map();
  if (targets.length === 0) return result;

  const targetIds = targets.map((t) => t.id);
  const { data: cycleRows, error: cyclesError } = await db()
    .from("pipeline_cycles")
    .select("*")
    .in("target_company_id", targetIds)
    .order("cycle_number");
  if (cyclesError) throw cyclesError;

  const cycles = (cycleRows ?? []) as CycleRow[];
  const cycleIds = cycles.map((c) => c.id);

  let programs: ProgramRow[] = [];
  let notes: NoteRow[] = [];
  let applications: ApplicationRow[] = [];
  let rounds: RoundRow[] = [];

  if (cycleIds.length > 0) {
    const [programsRes, notesRes, applicationsRes, roundsRes] = await Promise.all([
      db().from("pipeline_programs").select("*").in("cycle_id", cycleIds).order("position"),
      db().from("pipeline_notes").select("*").in("cycle_id", cycleIds).order("position"),
      db().from("pipeline_applications").select("*").in("cycle_id", cycleIds).order("position"),
      db().from("pipeline_interview_rounds").select("*").in("cycle_id", cycleIds).order("position"),
    ]);
    for (const res of [programsRes, notesRes, applicationsRes, roundsRes]) {
      if (res.error) throw res.error;
    }
    programs = (programsRes.data ?? []) as ProgramRow[];
    notes = (notesRes.data ?? []) as NoteRow[];
    applications = (applicationsRes.data ?? []) as ApplicationRow[];
    rounds = (roundsRes.data ?? []) as RoundRow[];
  }

  const byCycle = <T extends { cycle_id: number }>(rows: T[]) => {
    const map = new Map<number, T[]>();
    for (const row of rows) {
      const list = map.get(row.cycle_id) ?? [];
      list.push(row);
      map.set(row.cycle_id, list);
    }
    return map;
  };
  const programsByCycle = byCycle(programs);
  const notesByCycle = byCycle(notes);
  const applicationsByCycle = byCycle(applications);
  const roundsByCycle = byCycle(rounds);

  for (const target of targets) {
    const targetCycles = cycles.filter((c) => c.target_company_id === target.id);
    const cycleMap: Record<string, CycleFormState> = {};
    for (const cycle of targetCycles) {
      cycleMap[String(cycle.cycle_number)] = cycleFormFromRows(
        cycle,
        programsByCycle.get(cycle.id) ?? [],
        notesByCycle.get(cycle.id) ?? [],
        applicationsByCycle.get(cycle.id) ?? [],
        roundsByCycle.get(cycle.id) ?? [],
      );
    }

    const cycleCount = targetCycles.length > 0
      ? Math.max(...targetCycles.map((c) => c.cycle_number))
      : 0;

    result.set(scopeKeyForLocationId(target.location_id), {
      targetId: target.id,
      locationId: target.location_id,
      isTargeted: target.is_targeted,
      status: target.status,
      scope: {
        cycleCount,
        activeCycle: Math.min(Math.max(target.active_cycle, 1), Math.max(cycleCount, 1)),
        cycles: cycleMap,
      },
    });
  }

  return result;
}

/**
 * Make sure a target row exists (and is targeted) for the scope; returns
 * its id. Race-free enough for a single user editing their own page.
 */
export async function ensureScopeTarget(
  userId: string,
  companyId: number,
  locationId: number | null,
  seed?: { status?: PipelineStage },
): Promise<number> {
  let query = db()
    .from("target_companies")
    .select("id, is_targeted")
    .eq("user_id", userId)
    .eq("company_id", companyId);
  query = locationId == null ? query.is("location_id", null) : query.eq("location_id", locationId);
  const { data: existing, error: lookupError } = await query.maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    if (!existing.is_targeted) {
      const { error } = await db()
        .from("target_companies")
        .update({ is_targeted: true, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
    }
    return existing.id;
  }

  const { data: inserted, error: insertError } = await db()
    .from("target_companies")
    .insert({
      user_id: userId,
      company_id: companyId,
      location_id: locationId,
      is_targeted: true,
      ...(seed?.status ? { status: seed.status } : {}),
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return (inserted as { id: number }).id;
}

/** Soft un-target: hides the scope from target views, keeps pipeline data. */
export async function setScopeUntargeted(targetId: number): Promise<void> {
  const { error } = await db()
    .from("target_companies")
    .update({ is_targeted: false, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

/** Keep the scope row's status in sync with the active cycle's stage. */
export async function syncScopeStatus(targetId: number, stage: PipelineStage): Promise<void> {
  if (!PIPELINE_STAGES.includes(stage)) return;
  const { error } = await db()
    .from("target_companies")
    .update({ status: stage, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

export async function setScopeActiveCycle(targetId: number, activeCycle: number): Promise<void> {
  const { error } = await db()
    .from("target_companies")
    .update({ active_cycle: activeCycle, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

// ── Cycle persistence (RPCs) ───────────────────────────────────────────

export interface PipelineCyclePayload {
  selected_stage: PipelineStage;
  declined_next_cycle: boolean;
  programs: Array<{ id: string; name: string; apps_open: string; job_potential: string }>;
  notes: Array<{ id: string; body: string }>;
  applications: Array<{
    id: string;
    job_title: string;
    location: string;
    date_applied: string;
    resume_path: string | null;
    resume_name: string | null;
    resume_size_bytes: number | null;
    cover_letter_path: string | null;
    cover_letter_name: string | null;
    cover_letter_size_bytes: number | null;
  }>;
  interview_rounds: Array<{
    id: string;
    interview_date: string;
    interviewer: string;
    questions: string;
  }>;
}

export function cyclePayloadFromForm(form: CycleFormState): PipelineCyclePayload {
  return {
    selected_stage: form.selectedStage,
    declined_next_cycle: form.closed.declinedNextCycle,
    programs: form.researching.programs.map((p) => ({
      id: p.id,
      name: p.name,
      apps_open: p.appsOpen,
      job_potential: p.jobPotential,
    })),
    notes: form.researching.notes.map((n) => ({ id: n.id, body: n.body })),
    applications: form.applied.applications.map((a) => ({
      id: a.id,
      job_title: a.jobTitle,
      location: a.location,
      date_applied: a.dateApplied,
      resume_path: a.resume?.path ?? null,
      resume_name: a.resume?.name ?? null,
      resume_size_bytes: a.resume?.sizeBytes ?? null,
      cover_letter_path: a.coverLetter?.path ?? null,
      cover_letter_name: a.coverLetter?.name ?? null,
      cover_letter_size_bytes: a.coverLetter?.sizeBytes ?? null,
    })),
    interview_rounds: form.interviewing.rounds.map((r) => ({
      id: r.id,
      interview_date: r.date,
      interviewer: r.interviewer,
      questions: r.questions,
    })),
  };
}

export async function savePipelineCycle(
  targetId: number,
  cycleNumber: number,
  form: CycleFormState,
): Promise<void> {
  const { error } = await db().rpc("save_pipeline_cycle", {
    p_target_company_id: targetId,
    p_cycle_number: cycleNumber,
    p_payload: cyclePayloadFromForm(form),
  });
  if (error) throw error;
}

export async function deletePipelineCycle(targetId: number, cycleNumber: number): Promise<void> {
  const { error } = await db().rpc("delete_pipeline_cycle", {
    p_target_company_id: targetId,
    p_cycle_number: cycleNumber,
  });
  if (error) throw error;
}

// ── Application PDFs (Supabase Storage) ────────────────────────────────

export function isApplicationPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export async function uploadApplicationPdf(userId: string, file: File): Promise<PipelineFileRef> {
  const path = `${userId}/${crypto.randomUUID()}.pdf`;
  const { error } = await db()
    .storage.from(APPLICATION_FILES_BUCKET)
    .upload(path, file, { contentType: "application/pdf" });
  if (error) throw error;
  return { path, name: file.name, sizeBytes: file.size };
}

export async function applicationPdfSignedUrl(path: string): Promise<string> {
  const { data, error } = await db()
    .storage.from(APPLICATION_FILES_BUCKET)
    .createSignedUrl(path, 60 * 10);
  if (error) throw error;
  return data.signedUrl;
}

/** Best-effort delete — an orphaned blob is preferable to a failed edit. */
export async function deleteApplicationPdf(path: string): Promise<void> {
  try {
    await db().storage.from(APPLICATION_FILES_BUCKET).remove([path]);
  } catch {
    // ignore — RLS or transient failures shouldn't block the form
  }
}
