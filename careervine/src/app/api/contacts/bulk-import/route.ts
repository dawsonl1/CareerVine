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
  handler: async ({ supabase, user, body }) => {
    const { people, batch } = body as unknown as { people: PersonImportInput[]; batch?: string };
    // contact_imported + the contacts_5 check are emitted inside
    // importPeopleChunk with the ACTUAL created count — re-sent idempotent
    // chunks and dedupes no longer inflate the metric (CAR-58).
    const result = await importPeopleChunk(supabase, user.id, people, {
      batch,
      analyticsSource: "bulk",
    });
    return result;
  },
});
