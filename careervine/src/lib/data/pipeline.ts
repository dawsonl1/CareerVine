/**
 * Recruiting-pipeline domain queries shared by web and MCP (CAR-151 seam).
 *
 * Lives here rather than in src/mcp/lib/db.ts so both callers share one
 * implementation and one set of scoping guarantees. Client resolution is lazy
 * via db(); functions throw on failure.
 */

import { randomUUID } from "node:crypto";
import { db, must } from "./client";

/**
 * The five recruiting stages, in order. Duplicated from `pipeline-state.ts`
 * rather than imported: that module is a client component's state model and
 * pulling it in here would drag React types into the data layer.
 */
const PIPELINE_STAGES = ["researching", "outreach_active", "applied", "interviewing", "closed"] as const;
export type TargetCompanyStage = (typeof PIPELINE_STAGES)[number];

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
 * CACHE: CAR-256's `invalidateCompaniesList` is browser module state. Calling it
 * from a server process would invalidate nothing, so it is deliberately not
 * called — a stage set through here reaches the list on its next fetch or after
 * the 5-minute TTL.
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
    .eq("user_id", userId);
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
