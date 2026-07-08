/**
 * Client-side driver for /api/gmail/sync.
 *
 * The server syncs in time-budgeted passes and returns a cursor when more
 * contacts remain; this loops until the pass completes so callers get one
 * promise for a full sync regardless of contact count.
 */

export interface FullSyncResult {
  totalSynced: number;
  failedContacts: number;
  bounced: number;
}

// 40 passes × ~1000s of contacts per pass is far beyond any realistic
// account size — this is a runaway guard, not a coverage limit.
const MAX_PASSES = 40;

export async function runFullGmailSync(): Promise<FullSyncResult> {
  let cursor: number | undefined;
  let totalSynced = 0;
  let failedContacts = 0;
  let bounced = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const res = await fetch("/api/gmail/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cursor === undefined ? {} : { cursor }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Sync failed");
    }

    totalSynced += data.totalSynced ?? 0;
    failedContacts += data.failedContacts ?? 0;
    bounced += data.bounced ?? 0;

    if (data.nextCursor == null) break;
    cursor = data.nextCursor;
  }

  return { totalSynced, failedContacts, bounced };
}
