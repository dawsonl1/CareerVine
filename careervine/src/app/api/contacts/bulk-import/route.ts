/**
 * POST /api/contacts/bulk-import — pipeline people-record import (plan 24).
 *
 * Accepts a chunk of ≤50 pipeline people-records, each optionally paired
 * with its Outreach_Tracker state (joined by linkedin_url in the load
 * script). Auth: same Bearer-token path the Chrome extension uses — the
 * pipeline script obtains a Supabase access token via the auth API.
 *
 * Idempotent: canonical linkedin_url / public_identifier dedupe + the
 * merge engine. Suppressed (deleted-then-tombstoned) people are skipped
 * and reported. Tracker outreach state applies only when a contact is
 * first created — after that CareerVine owns outreach state.
 */

import { withApiHandler } from "@/lib/api-handler";
import { contactsBulkImportSchema } from "@/lib/api-schemas";
import { handleOptions } from "@/lib/extension-auth";
import { importPeopleChunk, type PersonImportInput } from "@/lib/bulk-import";
import { checkContactMilestone } from "@/lib/analytics/server";

// Bulk chunks do real work (photo downloads, per-person merges) — ask
// Vercel for the full window.
export const maxDuration = 60;

export async function OPTIONS() {
  return handleOptions();
}

export const POST = withApiHandler({
  schema: contactsBulkImportSchema,
  extensionAuth: true,
  cors: true,
  handler: async ({ supabase, user, body, track }) => {
    const { people, batch } = body as unknown as { people: PersonImportInput[]; batch?: string };
    const result = await importPeopleChunk(supabase, user.id, people, batch);
    track("contact_imported", { source: "bulk", count: people.length });
    await checkContactMilestone(user.id);
    return result;
  },
});
