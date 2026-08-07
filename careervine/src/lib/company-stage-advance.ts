/**
 * Advance a company's recruiting pipeline to Active outreach once someone there
 * actually replies (CAR-239).
 *
 * Before this, `target_companies.status` only ever moved because the user moved
 * a stage by hand: `usePipelineAutosave` mirrors the active cycle's selected
 * stage onto the target row and nothing else writes it. So a company could sit
 * on "Researching" after a contact had replied and even taken a call.
 *
 * Two invariants, both load-bearing:
 *
 *  1. FORWARD ONLY. A company at Applied, Interviewing or Closed is left alone.
 *     A stray reply on an old thread must never drag a live application
 *     backwards, which would be worse than the staleness this fixes.
 *  2. Only "researching" advances. That is the single transition with an
 *     unambiguous meaning: outreach has started because someone answered.
 *  3. CURRENT EMPLOYMENT ONLY (CAR-243). A reply is evidence about where the
 *     person works NOW. Without the is_current filter this advanced every
 *     company the contact had ever worked at: one reply from a contact with a
 *     long resume moved Walmart, Goldman Sachs and four others to "Active
 *     outreach" for companies they left years ago. A contact with no current
 *     employment row advances nothing, which is the honest answer — falling
 *     back to all employers is how the bug looked in the first place.
 *
 * Writes both the target row and the active cycle's `selected_stage`, because
 * the company page reads the cycle and the companies list reads the target. If
 * only one moved, the two surfaces would disagree.
 */

export interface StageAdvanceClient {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The one stage this automation is allowed to leave. */
const ADVANCE_FROM = "researching";
/** The stage it moves to. */
const ADVANCE_TO = "outreach_active";
/**
 * Row ceiling for the three reads below. PostgREST truncates silently at 1000,
 * so every read here carries an explicit bound and a stable order rather than
 * relying on the default.
 */
const MAX_ROWS = 1000;

export interface AdvanceResult {
  /** target_companies.id rows moved to outreach_active. */
  advanced: number[];
}

/**
 * Move every company target that owns one of `contactIds` from Researching to
 * Active outreach. Returns the target ids actually moved.
 */
export async function advanceCompaniesForContacts(
  client: StageAdvanceClient,
  userId: string,
  contactIds: number[],
): Promise<AdvanceResult> {
  const ids = [...new Set(contactIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return { advanced: [] };

  // Which companies do these contacts work at RIGHT NOW? is_current is
  // load-bearing, not a refinement — see invariant 3 in the header.
  const { data: links, error: linkErr } = await client
    .from("contact_companies")
    .select("company_id, contacts!inner(user_id)")
    .in("contact_id", ids)
    .eq("contacts.user_id", userId)
    .eq("is_current", true)
    // Deliberate bound, not pagination: `ids` comes from the replied threads of
    // one sync, and a contact has a handful of employers. Ordered so the window
    // is stable if it is ever reached.
    .order("contact_id")
    .limit(MAX_ROWS);
  if (linkErr) throw linkErr;

  const companyIds = [
    ...new Set(((links ?? []) as Array<{ company_id: number | null }>)
      .map((l) => l.company_id)
      .filter((id): id is number => id != null)),
  ];
  if (companyIds.length === 0) return { advanced: [] };

  // Only targets still sitting in Researching. Scoped to the user because the
  // service client bypasses RLS on every path that calls this.
  const { data: targets, error: targetErr } = await client
    .from("target_companies")
    .select("id, active_cycle")
    .eq("user_id", userId)
    .eq("status", ADVANCE_FROM)
    .in("company_id", companyIds)
    // At most one target row per (user, company, office scope).
    .order("id")
    .limit(MAX_ROWS);
  if (targetErr) throw targetErr;

  const rows = (targets ?? []) as Array<{ id: number; active_cycle: number | null }>;
  if (rows.length === 0) return { advanced: [] };

  const targetIds = rows.map((t) => t.id);

  // Re-assert status = researching in the UPDATE itself so a concurrent manual
  // move to Applied between the read and the write is not clobbered.
  const { error: updateErr } = await client
    .from("target_companies")
    .update({ status: ADVANCE_TO })
    .eq("user_id", userId)
    .eq("status", ADVANCE_FROM)
    .in("id", targetIds);
  if (updateErr) throw updateErr;

  // Mirror onto the active cycle so the company page agrees with the list view.
  for (const target of rows) {
    const cycleNumber = target.active_cycle || 1;
    const { error: cycleErr } = await client
      .from("pipeline_cycles")
      .update({ selected_stage: ADVANCE_TO })
      .eq("target_company_id", target.id)
      .eq("cycle_number", cycleNumber)
      .eq("selected_stage", ADVANCE_FROM);
    if (cycleErr) throw cycleErr;
  }

  return { advanced: targetIds };
}

/**
 * Resolve the contacts behind a set of replied threads, then advance their
 * companies. Best-effort by contract: the caller treats reply sweeps as
 * non-fatal, and a stale pipeline stage must never fail a mailbox sync.
 */
export async function advanceCompaniesForRepliedThreads(
  client: StageAdvanceClient,
  userId: string,
  threadIds: Iterable<string>,
): Promise<AdvanceResult> {
  const threads = [...new Set([...threadIds])].filter(Boolean);
  if (threads.length === 0) return { advanced: [] };

  const { data: messages, error } = await client
    .from("email_messages")
    .select("matched_contact_id, email_message_contacts(contact_id)")
    .eq("user_id", userId)
    .in("thread_id", threads)
    // Only needs enough messages to identify WHICH contacts replied, so a
    // partial window still resolves the same contact set in practice. Ordered
    // so the window is deterministic rather than whatever PostgREST returns.
    .order("id")
    .limit(MAX_ROWS);
  if (error) throw error;

  const contactIds: number[] = [];
  for (const m of (messages ?? []) as Array<{
    matched_contact_id: number | null;
    email_message_contacts: Array<{ contact_id: number | null }> | null;
  }>) {
    if (m.matched_contact_id != null) contactIds.push(m.matched_contact_id);
    for (const link of m.email_message_contacts ?? []) {
      if (link.contact_id != null) contactIds.push(link.contact_id);
    }
  }

  return advanceCompaniesForContacts(client, userId, contactIds);
}
