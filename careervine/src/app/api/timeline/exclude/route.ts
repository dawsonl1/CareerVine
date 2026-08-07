import { withApiHandler, ApiError } from "@/lib/api-handler";
import { timelineExcludeSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

/**
 * Strike a contact-timeline entry from every derived calculation (CAR-260), or
 * restore it.
 *
 * `is_excluded` is deliberately NOT `is_hidden`. Hidden is display-only: three
 * inbox reads honor it and no derivation does. Excluded means the row stays in
 * the record but stops feeding stage inference, company traction, network
 * health, streaks, last-touch, dossier grounding and every aggregate count.
 *
 * For an email, exclusion is a strict SUPERSET of hiding, so this sets both.
 * That is what makes the contact Emails tab and the inbox drop it with no
 * change to either: they already filter `is_hidden`. Restoring clears both,
 * which is why the inbox Hidden tab doubles as email's undo surface. The
 * reverse implication must never be added — plain inbox-hide has to stay
 * display-only, or every message the user ever archived would retroactively
 * stop counting.
 *
 * Ownership rides on RLS via the request-scoped client rather than a service
 * client plus a hand-written `user_id` filter. `interactions` has no `user_id`
 * column at all (every consumer scopes through `contacts!inner(user_id)`), so a
 * service client here would need a bespoke ownership join. Each update selects
 * back the rows it touched and 404s on an empty result, so another tenant's id
 * is a miss rather than a silent success.
 *
 * What this cannot undo: the three side effects an inbound message fires at
 * INGESTION (follow-up cancellation, company stage advance, the reply_received
 * event) are one-time writes, not derived values. Excluding the message after
 * the fact corrects every recomputed surface and leaves those three alone. The
 * confirm copy says so rather than implying a full rollback.
 */
type ExcludeBody = z.infer<typeof timelineExcludeSchema>;

async function setExcluded(supabase: SupabaseClient, body: ExcludeBody, excluded: boolean) {
  if (body.kind === "email") {
    // cas-checked: the filter is the unique (user via RLS, gmail_message_id)
    // key, never the written column, so this is a plain update-and-return. The
    // readback is an ownership probe rather than a race check: RLS makes a
    // foreign id match zero rows, which is the 404 below.
    const { data, error } = await supabase
      .from("email_messages")
      // Hidden moves with excluded so the surfaces already filtering it need no
      // change. See the header: the implication is one-directional.
      .update({ is_excluded: excluded, is_hidden: excluded })
      .eq("gmail_message_id", body.gmailMessageId)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new ApiError("That email could not be found.", 404);
    return;
  }

  if (body.kind === "meeting") {
    // cas-checked: filtered on the primary key, not on is_excluded. The
    // readback also has to return calendar_event_id, which a count cannot.
    const { data, error } = await supabase
      .from("meetings")
      .update({ is_excluded: excluded })
      .eq("id", body.id)
      .select("id, calendar_event_id");
    if (error) throw error;
    if (!data || data.length === 0) throw new ApiError("That meeting could not be found.", 404);

    // The stage engine reads calendar_events DIRECTLY, not only through the
    // meeting that mirrors it (company-queries.ts collapses the two on
    // google_event_id). Excluding just the meeting would leave hasPastCall and
    // hasUpcomingCall true, so the contact would keep deriving as call_done.
    const googleEventId = data[0]?.calendar_event_id;
    if (googleEventId) {
      const { error: calError } = await supabase
        .from("calendar_events")
        .update({ is_excluded: excluded })
        .eq("google_event_id", googleEventId);
      if (calError) throw calError;
    }
    return;
  }

  // Spelled out per kind rather than `.from(table)` with a variable. A dynamic
  // table name here is invisible to the contacts write-chokepoint scan
  // (contact-write-chokepoint.test.ts), and the duplication is a better trade
  // than an allowlist entry on the guard that keeps contact writes
  // canonicalizing. Two statements rather than a ternary so each carries its
  // own cas-checked annotation where the conventions scanner looks for it.
  if (body.kind === "interaction") {
    // cas-checked: filtered on the primary key, not on the written column;
    // the readback is the ownership probe RLS turns into the 404 below.
    const { data, error } = await supabase
      .from("interactions")
      .update({ is_excluded: excluded })
      .eq("id", body.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new ApiError("That entry could not be found.", 404);
    return;
  }

  // cas-checked: same shape as the interaction branch above — primary key
  // filter, readback as the ownership probe.
  const { data, error } = await supabase
    .from("follow_up_action_items")
    .update({ is_excluded: excluded })
    .eq("id", body.id)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new ApiError("That entry could not be found.", 404);
}

/** Strike the entry: it stays stored, and stops counting toward everything. */
export const POST = withApiHandler({
  schema: timelineExcludeSchema,
  handler: async ({ supabase, body }) => {
    await setExcluded(supabase, body, true);
    return { success: true };
  },
});

/** Restore it, so it counts again. */
export const DELETE = withApiHandler({
  schema: timelineExcludeSchema,
  handler: async ({ supabase, body }) => {
    await setExcluded(supabase, body, false);
    return { success: true };
  },
});
