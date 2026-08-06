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
