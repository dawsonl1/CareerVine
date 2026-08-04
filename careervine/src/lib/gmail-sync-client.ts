/**
 * Client-side driver for /api/gmail/sync.
 *
 * The server syncs in time-budgeted passes and returns a cursor when more
 * contacts remain; this loops until the pass completes so callers get one
 * promise for a full sync regardless of contact count.
 */

import { apiFetch, jsonBody } from "@/lib/api-client";

export interface FullSyncResult {
  totalSynced: number;
  failedContacts: number;
  /** Known-bounced addresses seen this pass, including ones already flagged. */
  bounced: number;
  /** Addresses that died on THIS pass. The only figure worth telling the user
   *  about: `bounced` re-reports the same addresses on every sync. */
  newlyBounced: number;
}

// 40 passes × ~1000s of contacts per pass is far beyond any realistic
// account size — this is a runaway guard, not a coverage limit.
const MAX_PASSES = 40;

export async function runFullGmailSync(): Promise<FullSyncResult> {
  let cursor: number | undefined;
  let totalSynced = 0;
  let failedContacts = 0;
  let bounced = 0;
  let newlyBounced = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // apiFetch throws ApiRequestError with the route's own `error` message on
    // a non-2xx, so the explicit !res.ok branch this replaced is now implicit.
    const data = await apiFetch<{
      totalSynced?: number;
      failedContacts?: number;
      bounced?: number;
      newlyBounced?: number;
      nextCursor?: number | null;
    }>("/api/gmail/sync", jsonBody(cursor === undefined ? {} : { cursor }));

    totalSynced += data.totalSynced ?? 0;
    failedContacts += data.failedContacts ?? 0;
    bounced += data.bounced ?? 0;
    newlyBounced += data.newlyBounced ?? 0;

    if (data.nextCursor == null) break;
    cursor = data.nextCursor;
  }

  return { totalSynced, failedContacts, bounced, newlyBounced };
}
