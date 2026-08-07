/**
 * Recruiting-pipeline domain queries shared by web and MCP (CAR-151 seam).
 *
 * Lives here rather than in src/mcp/lib/db.ts so both callers share one
 * implementation and one set of scoping guarantees. Client resolution is lazy
 * via db(); functions throw on failure.
 */

import { randomUUID } from "node:crypto";
import { db, must } from "./client";
import { paginateAll } from "./postgrest";
import {
  loadPipeline,
  savePipelineCycle,
  type LoadedPipeline,
} from "@/lib/pipeline-queries";
import { createPipelineEntityId, type CycleFormState } from "@/lib/pipeline-state";

/**
 * Read a company's whole recruiting board (CAR-270).
 *
 * A thin re-export of `loadPipeline`, and the indirection is the point.
 * `src/lib/pipeline-queries.ts` sits OUTSIDE the MCP scoping gate: that suite
 * globs `src/lib/data/*.ts` exactly, so a tool importing `loadPipeline` directly
 * would compile, pass CI, and be the one MCP data path in the codebase with no
 * mechanical scoping enforcement at all. Routing through this module pulls it
 * into `DATA_TABLES`, which forces a classification entry and a drive that
 * exercises its real queries.
 *
 * `loadPipeline` scopes at the root (`target_companies` filtered by user_id) and
 * everything below keys on ids that read produced — the ownership pattern the
 * gate models. Safe as written, and now checked.
 *
 * Returns an empty Map when the user has no target row for the company, rather
 * than throwing: "not a target" is an answer, not an error.
 */
export async function loadCompanyPipeline(
  userId: string,
  companyId: number,
): Promise<LoadedPipeline> {
  // Ownership is proven HERE, in the gated module, rather than inherited from
  // `loadPipeline`'s own root filter. A bare delegation would have been a
  // pass-through: the scoping gate's provenance check flagged it, because no
  // query originated in this file and the classification would have been a
  // claim about code the gate cannot see. This read is scoped, cheap, and makes
  // the guarantee local — if `loadPipeline` ever loses its filter, this still
  // refuses a company the user does not target.
  const owned = must(
    await db()
      .from("target_companies")
      .select("id")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      // CAR-271 meets CAR-270 here. This read is the ownership proof for the
      // whole append surface (resolveCycleForAppend routes both log_application
      // and log_interview_round through it), so it is also the one place that
      // can keep the agent out of a deleted company's board. Without it, the
      // tombstone hides the company from every UI while an MCP tool still reads
      // and writes its pipeline.
      .eq("is_deleted", false)
      .limit(1),
  ) as Array<{ id: number }> | null;
  if (!owned || owned.length === 0) return new Map();

  return loadPipeline(userId, companyId);
}

/** What an append needs to locate: one scope's cycle, and the target that owns it. */
async function resolveCycleForAppend(
  userId: string,
  companyId: number,
  scopeKey: string,
  cycleNumber?: number,
): Promise<{ targetId: number; cycleNumber: number; form: CycleFormState }> {
  const pipeline = await loadCompanyPipeline(userId, companyId);
  const scope = pipeline.get(scopeKey);
  if (!scope) {
    throw new Error(
      `No pipeline scope "${scopeKey}" for company ${companyId} — target the company first, or use scope "all".`,
    );
  }
  const cycle = cycleNumber ?? scope.scope.activeCycle;
  const form = scope.scope.cycles[String(cycle)];
  if (!form) throw new Error(`Company ${companyId} has no cycle ${cycle} in scope "${scopeKey}"`);
  return { targetId: scope.targetId, cycleNumber: cycle, form };
}

/**
 * Append one entry to a cycle collection and persist the whole cycle (CAR-270).
 *
 * Sends the FULL collection, not just the new row, because
 * `save_pipeline_cycle` assigns `position = ord - 1` across whatever payload it
 * receives: a one-row payload would renumber that row to position 0 and collide
 * with the entries already there. This is what the UI does too.
 *
 * No `deleted` key, ever. CAR-238 made deletion explicit precisely so a writer
 * that has not seen every row cannot destroy the ones it does not know about,
 * and an append has no business removing anything.
 *
 * `loadCompanyPipeline` above is the ownership proof: its root read is scoped to
 * `userId`, and `save_pipeline_cycle` itself performs NO ownership check — it is
 * SECURITY INVOKER relying on RLS, which the MCP service client bypasses. The
 * target id handed to the RPC must therefore be one this call already proved.
 */
async function appendToCycle(
  userId: string,
  companyId: number,
  scopeKey: string,
  cycleNumber: number | undefined,
  mutate: (form: CycleFormState) => CycleFormState,
): Promise<{ targetId: number; cycleNumber: number }> {
  const { targetId, cycleNumber: cycle, form } = await resolveCycleForAppend(
    userId,
    companyId,
    scopeKey,
    cycleNumber,
  );
  await savePipelineCycle(targetId, cycle, mutate(form));
  return { targetId, cycleNumber: cycle };
}

export interface ApplicationInput {
  jobTitle: string;
  location?: string;
  dateApplied?: string;
}

/** Log an application on a cycle. Attachments are upload-only, so none are set. */
export async function appendApplication(
  userId: string,
  companyId: number,
  scopeKey: string,
  cycleNumber: number | undefined,
  input: ApplicationInput,
): Promise<{ targetId: number; cycleNumber: number; applicationId: string }> {
  const applicationId = createPipelineEntityId();
  const result = await appendToCycle(userId, companyId, scopeKey, cycleNumber, (form) => ({
    ...form,
    applied: {
      applications: [
        ...form.applied.applications,
        {
          id: applicationId,
          jobTitle: input.jobTitle,
          location: input.location ?? "",
          dateApplied: input.dateApplied ?? "",
          // PDFs are browser uploads into a private bucket; there is no path an
          // agent could supply that would resolve.
          resume: null,
          coverLetter: null,
        },
      ],
    },
  }));
  return { ...result, applicationId };
}

export interface InterviewRoundInput {
  date?: string;
  interviewer?: string;
  /** Column is `questions`; the UI labels it "Interview notes". Free text. */
  notes?: string;
}

/** Log an interview round on a cycle. */
export async function appendInterviewRound(
  userId: string,
  companyId: number,
  scopeKey: string,
  cycleNumber: number | undefined,
  input: InterviewRoundInput,
): Promise<{ targetId: number; cycleNumber: number; roundId: string }> {
  const roundId = createPipelineEntityId();
  const result = await appendToCycle(userId, companyId, scopeKey, cycleNumber, (form) => ({
    ...form,
    interviewing: {
      rounds: [
        ...form.interviewing.rounds,
        {
          id: roundId,
          date: input.date ?? "",
          interviewer: input.interviewer ?? "",
          questions: input.notes ?? "",
        },
      ],
    },
  }));
  return { ...result, roundId };
}

/**
 * The five recruiting stages. A type, not a runtime array: the only caller is
 * an MCP tool whose zod enum already validates the value at the boundary, so a
 * second list here would be a copy to keep in sync for nothing.
 *
 * Spelled out rather than imported from `pipeline-state.ts`, which is a client
 * component's state model and would drag React types into the data layer.
 */
export type TargetCompanyStage =
  | "researching"
  | "outreach_active"
  | "applied"
  | "interviewing"
  | "closed";

/**
 * Set a company target's pipeline stage, by explicit instruction (CAR-265).
 *
 * WRITES BOTH LEGS, and that is the whole reason this function exists.
 * `company-stage-advance.ts` states the invariant: the company page reads
 * `pipeline_cycles.selected_stage` while the companies list reads
 * `target_companies.status`, so moving one leaves the two surfaces disagreeing.
 * No existing helper does both for an arbitrary stage — `syncScopeStatus` writes
 * only the target row, and every caller pairs it with `savePipelineCycle` by
 * hand (see use-pipeline-autosave.ts). MCP has no such caller to lean on.
 *
 * DELIBERATELY UNGATED on employment and direction, unlike
 * `advanceCompaniesForContacts`. That one infers intent from a reply, so it is
 * forward-only and gated on `is_current` — a stray reply must never drag a live
 * application backwards. This is somebody saying which stage the company is at,
 * the equivalent of moving it in the UI, so it has to be able to move backwards:
 * a stage set by mistake must be correctable by the same route that set it.
 *
 * What it is NOT missing: `user_id` on the update. CAR-255 deleted
 * `updateTargetCompany` for writing this column with `.eq("id")` as its only
 * predicate, which is unsafe precisely here, under a service client that
 * bypasses RLS.
 *
 * CACHE: CAR-256's `refreshCompaniesList` is browser module state. Calling it
 * from a server process would refresh nothing, so it is deliberately not
 * called — a stage set through here reaches the list on its next fetch or after
 * `COMPANIES_LIST_TTL_MS` expires. That TTL is the ONLY bound on this path,
 * which is the reason it is not longer than it is (CAR-278).
 *
 * @param userId Owner. `pipeline_cycles` has no user_id, so ownership is proven
 *               on the parent target row before the cycle is touched.
 */
export async function setCompanyStage(
  userId: string,
  targetCompanyId: number,
  stage: TargetCompanyStage,
): Promise<{ previousStage: string | null }> {
  const target = must(
    await db()
      .from("target_companies")
      .select("id, active_cycle, status")
      .eq("id", targetCompanyId)
      .eq("user_id", userId)
      // A deleted company is not a stage that can be moved (CAR-271). Callers
      // reach this through getOrCreateTargetCompany, which already refuses, so
      // this is depth rather than the only lock — but the id is a caller-supplied
      // integer and the client here is service-role.
      .eq("is_deleted", false)
      .maybeSingle(),
  ) as { id: number; active_cycle: number | null; status: string | null } | null;
  if (!target) throw new Error(`No target company with id ${targetCompanyId}`);

  const previousStage = target.status ?? null;
  if (previousStage === stage) return { previousStage };

  const { error: statusErr } = await db()
    .from("target_companies")
    .update({ status: stage, updated_at: new Date().toISOString() })
    .eq("id", targetCompanyId)
    .eq("user_id", userId);
  if (statusErr) throw statusErr;

  // Mirror onto the active cycle. Upserted, not updated: a company whose
  // pipeline panel was never opened has no cycle row at all, and the page seeds
  // its stage from target_companies.status in that case — but the moment a row
  // DOES exist it wins, so leaving a stale one behind is how the two surfaces
  // drift apart.
  const cycleNumber = target.active_cycle || 1;
  const { error: cycleErr } = await db()
    .from("pipeline_cycles")
    .upsert(
      { target_company_id: targetCompanyId, cycle_number: cycleNumber, selected_stage: stage },
      { onConflict: "target_company_id,cycle_number", ignoreDuplicates: false },
    );
  if (cycleErr) throw cycleErr;

  return { previousStage };
}

/**
 * Update a company target's research fields (CAR-265).
 *
 * `next_app_date` had no writer anywhere in the app before this. It is what the
 * outreach queue's boost window orders by, so an agent could consume an ordering
 * it had no way to improve — it could read an application deadline off a careers
 * page and had nowhere to put it.
 *
 * Only the fields passed are written, so a caller setting a deadline cannot
 * blank a program name it never mentioned. `status` and `is_targeted` are NOT
 * settable here: status goes through `setCompanyStage`, which also mirrors the
 * cycle, and targeting has its own semantics.
 */
export async function updateTargetResearch(
  userId: string,
  targetCompanyId: number,
  patch: {
    priority_score?: number | null;
    program_name?: string | null;
    app_window_text?: string | null;
    next_app_date?: string | null;
  },
): Promise<void> {
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(fields).length === 0) return;

  const { error, count } = await db()
    .from("target_companies")
    .update({ ...fields, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", targetCompanyId)
    .eq("user_id", userId)
    // Deleted companies take no research writes (CAR-271). Expressed as a
    // predicate rather than a prior read so the zero count already means "not
    // yours, or gone" and the existing error covers both.
    .eq("is_deleted", false);
  if (error) throw error;
  // No returning read: the count is the ownership signal, and a zero here means
  // the row is not this user's rather than that the write silently did nothing.
  if (!count) throw new Error(`No target company with id ${targetCompanyId}`);
}

/**
 * Append a note to a company target's ACTIVE pipeline cycle (CAR-238).
 *
 * This writes the same `pipeline_notes` row the company page's "Add note"
 * button writes. The MCP tool previously wrote `target_company_notes`, which
 * the UI renders only as a fallback while there are zero pipeline notes, so the
 * first note a user typed hid every agent-written note permanently.
 *
 * Safe to interleave with the UI only because `save_pipeline_cycle` now deletes
 * exactly the ids the saving client names (CAR-238). Under the old
 * delete-not-in reconcile this row would have been destroyed by the user's next
 * keystroke.
 *
 * @param userId  Owner. `pipeline_notes` has no user_id, so ownership is
 *                asserted on the parent target row before anything is written.
 */
export async function addPipelineNote(
  userId: string,
  targetCompanyId: number,
  body: string,
): Promise<void> {
  const target = must(
    await db()
      .from("target_companies")
      .select("id, active_cycle")
      .eq("id", targetCompanyId)
      .eq("user_id", userId)
      // No notes onto a deleted company (CAR-271).
      .eq("is_deleted", false)
      .maybeSingle(),
  );
  if (!target) throw new Error(`No target company with id ${targetCompanyId}`);

  const cycleNumber = (target as { active_cycle: number | null }).active_cycle || 1;

  // The cycle row may not exist on a company whose pipeline was never opened.
  const cycle = must(
    await db()
      .from("pipeline_cycles")
      .upsert(
        { target_company_id: targetCompanyId, cycle_number: cycleNumber },
        { onConflict: "target_company_id,cycle_number", ignoreDuplicates: false },
      )
      .select("id")
      .single(),
  );
  const cycleId = (cycle as { id: number }).id;

  // Append after what is already there rather than colliding on position 0.
  const last = must(
    await db()
      .from("pipeline_notes")
      .select("position")
      .eq("cycle_id", cycleId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  const position = ((last as { position: number } | null)?.position ?? -1) + 1;

  const { error } = await db()
    .from("pipeline_notes")
    .insert({ id: randomUUID(), cycle_id: cycleId, body, position });
  if (error) throw error;
}

/**
 * Company ids this user has deleted (CAR-271).
 *
 * The tombstone for a deleted company is its company-wide `target_companies`
 * row. `companies` itself is global and holds no per-user state, so any code
 * resolving a company by NAME or by a caller-supplied id is searching a table
 * that cannot know the caller deleted it. This turns those tombstones back into
 * something such a resolver can filter on.
 *
 * Fetched as a set rather than probed per candidate on purpose: it is a handful
 * of rows, and having the whole set lets a resolver DROP a deleted company from
 * its ambiguity candidates rather than merely reject it afterwards, so "Acme"
 * does not report an ambiguity against a company the user removed.
 *
 * Paged rather than read in one shot. One row per deleted company sounds small,
 * and normally is, but decluttering a bundle-sized network is exactly the
 * workflow that produces these rows, and PostgREST truncates at 1000 with
 * `error: null`. A silent truncation here fails OPEN: the missing ids read as
 * "not deleted", and the company the user removed resolves again.
 */
export async function deletedCompanyIds(userId: string): Promise<Set<number>> {
  // deleted-exempt: this read IS the tombstone lookup. Filtering is_deleted to
  // false here would return every company EXCEPT the deleted ones, i.e. the
  // exact inverse of what every caller wants.
  const rows = await paginateAll<{ company_id: number }>(async (from, to) =>
    must(
      await db()
        .from("target_companies")
        .select("company_id")
        .eq("user_id", userId)
        .is("location_id", null)
        .eq("is_deleted", true)
        .order("company_id")
        .range(from, to),
    ),
  );
  return new Set(rows.map((r) => r.company_id));
}
