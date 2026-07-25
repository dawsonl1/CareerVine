/**
 * Flow 6 (CAR-191): sync the calendar and prove the four APPLICATION-OWNED
 * columns on `calendar_events` survive it.
 *
 * ── The bug this exists for ───────────────────────────────────────────────
 *
 * CAR-175: a repair migration erased `source_gmail_thread_id` across the table,
 * which silently cut every email-to-meeting link the inbox renders. The columns
 * at risk are the ones Google has no record of and therefore cannot restore:
 *
 *   source_gmail_thread_id, source_gmail_message_id, meeting_id, zoom_link
 *
 * What protects them today is an ABSENCE: `/api/calendar/sync` builds its upsert
 * payload (`rowByGoogleId.set(...)`) without those four keys, and PostgREST's
 * ON CONFLICT DO UPDATE only touches keys the payload actually carries. That is
 * a real guarantee, but it is the kind that a well-meaning edit deletes without
 * noticing — adding one of these to the row builder "for completeness" would
 * clobber user data on every sync, and nothing about the change would look
 * dangerous.
 *
 * `migration-destructive-guard.test.ts` pins the registry; this pins the
 * BEHAVIOUR, through a real sync against a real Postgres.
 *
 * ── Why the assertion needs both halves ───────────────────────────────────
 *
 * "The four columns are unchanged" is trivially true if the sync did nothing at
 * all — a 400, an empty event list, a cooldown 429 all produce it. So the flow
 * asserts the Google-owned fields DID change in the same pass. Together they say
 * the sync ran, wrote, and left the app's columns alone.
 *
 * Two of the four are never POPULATED by any surface today: `meeting_id` and
 * `zoom_link` are named only by the MCP create-meeting insert (`src/mcp/lib/db.ts`),
 * which writes literal `null` into both. So the service client seeds all four
 * directly. That is the honest setup: the flow is about surviving a sync, not
 * about how the values got there.
 */
import fs from "node:fs";
import { test, expect } from "./fixtures/test";
import {
  TENANT_FILE,
  grantCalendarScope,
  serviceClient,
  uniq,
  type E2ETenantRecord,
} from "./helpers/tenant";
import { E2E_CALENDAR_EVENT_ID } from "./fixtures/google-wire.mjs";

const tenant = (): E2ETenantRecord => JSON.parse(fs.readFileSync(TENANT_FILE, "utf8"));

/**
 * Hand the calendar scope back.
 *
 * The grant is shared-tenant state, and leaving it on is observable elsewhere:
 * the settings integrations card renders "Connect Gmail" instead of "Connect
 * Gmail & Calendar" once the calendar is connected, so a spec that ran after
 * this one could pass or fail on whether this one ran at all. Revoking keeps the
 * calendar stub inert for every other flow, which is the whole reason the grant
 * is not in the setup project's seed.
 *
 * `afterEach`, not `finally`: a body abandoned at the test timeout never reaches
 * a `finally` (see `signup-onboard.spec.ts`).
 */
test.afterEach(async () => {
  const { userId } = tenant();
  const { error } = await serviceClient()
    .from("gmail_connections")
    .update({
      calendar_scopes_granted: false,
      calendar_last_synced_at: null,
      // Cleared too (CAR-191 review). The sync stores the stub's
      // `nextSyncToken`, and a token present on a CI retry sends attempt 2 down
      // the INCREMENTAL branch of `fetchCalendarEvents`, which omits
      // `timeMin`/`timeMax` entirely. MSW answers that shape happily and real
      // Google would return deltas only, so the retry would silently exercise a
      // request this flow never intends to make — and the poll's own failure
      // message names a time window that was never sent.
      calendar_sync_token: null,
    })
    .eq("user_id", userId);
  if (error) throw new Error(`revoking calendar scope: ${error.message}`);

  // Drop the row this spec seeded, so the tenant is left as it was found. Inert
  // today (nothing else reads it), but CONVENTIONS §i now states the restore
  // rule without qualification, and a future spec visiting /calendar would
  // inherit an order dependency.
  const { error: rowErr } = await serviceClient()
    .from("calendar_events")
    .delete()
    .eq("user_id", userId)
    .eq("google_event_id", E2E_CALENDAR_EVENT_ID);
  if (rowErr) throw new Error(`removing the seeded calendar event: ${rowErr.message}`);
});

/** The four columns CONVENTIONS §d designates application-owned. */
const APP_OWNED = [
  "source_gmail_thread_id",
  "source_gmail_message_id",
  "meeting_id",
  "zoom_link",
] as const;

async function readEvent(userId: string) {
  const { data, error } = await serviceClient()
    .from("calendar_events")
    .select(`title, start_at, synced_at, ${APP_OWNED.join(", ")}`)
    .eq("user_id", userId)
    .eq("google_event_id", E2E_CALENDAR_EVENT_ID)
    .single();
  if (error || !data) {
    throw new Error(`calendar event ${E2E_CALENDAR_EVENT_ID} not found: ${error?.message}`);
  }
  return data as unknown as Record<string, unknown>;
}

test("a calendar re-sync refreshes Google's fields and preserves the app's own (CAR-175)", async ({
  page,
}) => {
  const { userId } = tenant();
  const threadId = uniq("e2e-thread");
  const messageId = uniq("e2e-msg");
  const zoomLink = `https://zoom.us/j/${uniq("e2e")}`;

  await grantCalendarScope(userId);

  // `meeting_id` is a foreign key, so it needs a real meetings row. The tenant
  // graph already seeds one — reuse it rather than inventing a second.
  const { data: meeting, error: meetingErr } = await serviceClient()
    .from("meetings")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  if (meetingErr || !meeting) throw new Error(`no seeded meeting: ${meetingErr?.message}`);
  // Captured after the guard so the closure below sees a non-null id.
  const meetingId = meeting.id;

  /**
   * Write the row into its "stale" state: Google-owned fields deliberately
   * wrong, all four application-owned columns populated, and the sync cooldown
   * reopened.
   *
   * Called twice — once to set the flow up, and again after the page's mount
   * sync has refreshed the Google fields, so the explicit button still has
   * observable work to do. Resetting `calendar_last_synced_at` is what makes the
   * second call meaningful: every successful sync stamps it, and the route's
   * 5-second force cooldown would otherwise 429 the button (which the UI
   * deliberately reports as success).
   *
   * Upsert, not insert: `/` also fires a background sync, so the row may already
   * exist. Upserting on the same natural key the sync route uses converges from
   * any starting state, including a CI retry.
   */
  async function staleTheRow(uid: string): Promise<void> {
    const svc = serviceClient();
    const { error } = await svc.from("calendar_events").upsert(
      {
        user_id: uid,
        google_event_id: E2E_CALENDAR_EVENT_ID,
        calendar_id: "primary",
        // Deliberately stale and wrong: the sync must overwrite both.
        title: "STALE TITLE — the sync must replace this",
        start_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        end_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 + 1800_000).toISOString(),
        // Every real writer (sync, create-event, the MCP tool) stores an
        // array, so seeding one keeps this row shaped like production data.
        attendees: [],
        source_gmail_thread_id: threadId,
        source_gmail_message_id: messageId,
        meeting_id: meetingId,
        zoom_link: zoomLink,
      },
      { onConflict: "user_id,google_event_id" },
    );
    if (error) throw new Error(`seeding calendar event: ${error.message}`);

    const { error: cooldownErr } = await svc
      .from("gmail_connections")
      .update({ calendar_last_synced_at: null })
      .eq("user_id", uid);
    if (cooldownErr) throw new Error(`reopening the sync cooldown: ${cooldownErr.message}`);
  }

  await test.step("seed the event with all four application-owned columns set", async () => {
    await staleTheRow(userId);
  });

  /**
   * Let the page's own mount sync finish FIRST, then measure the button.
   *
   * `/calendar`'s `loadData` fires a background `POST /api/calendar/sync` on
   * mount, and `grantCalendarScope` nulls `calendar_last_synced_at`, so the
   * 5-minute cooldown is wide open and that sync lands within ~150ms. It writes
   * `synced_at` AND `calendar_last_synced_at` — which then puts the explicit
   * button inside the 5-second force cooldown, so its request 429s, and
   * `handleSync` deliberately treats a 429 as "already fresh" and swallows it
   * (calendar/page.tsx says so in as many words).
   *
   * The original version of this step read `before`, clicked, and polled — so
   * the mount sync satisfied the poll and the click was a no-op. Emptying
   * `handleSync` entirely left the test green, and which sync the assertion
   * measured was a genuine race. Waiting for the mount sync, re-staling the row,
   * and then asserting the button's OWN response is 200 makes the click
   * load-bearing.
   */
  await test.step("wait out the page's mount sync", async () => {
    const mountSync = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/calendar/sync" &&
        r.request().method() === "POST",
    );
    await page.goto("/calendar");
    await mountSync;
  });

  // Re-stale the Google-owned fields the mount sync just refreshed, so the
  // button's sync has something observable left to do.
  await staleTheRow(userId);
  const before = await readEvent(userId);

  await test.step("sync with the explicit button", async () => {
    // The forced request, awaited by identity rather than inferred. It carries
    // `force=true`, which is the 5-second cooldown rather than the 5-minute one.
    const forced = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/calendar/sync" && r.url().includes("force=true"),
    );
    await page.getByRole("button", { name: "Sync" }).click();
    const res = await forced;

    // 200, not merely "a response". A 429 here means the cooldown was still
    // closed and the button did nothing — which the UI would report as success.
    expect(
      res.status(),
      "the forced sync was refused; the cooldown was still closed, so the button did no work",
    ).toBe(200);

    await expect
      .poll(async () => (await readEvent(userId)).synced_at, {
        message:
          "synced_at never advanced after a 200 from the forced sync — the route returned " +
          "success without writing the event.",
        timeout: 15_000,
      })
      .not.toBe(before.synced_at);
  });

  const after = await readEvent(userId);

  await test.step("Google's fields were refreshed", async () => {
    // Proves the upsert genuinely touched this row. Without this, every
    // assertion below would also pass on a sync that did nothing.
    expect(after.title).toBe("E2E synced event");
    expect(after.title).not.toBe(before.title);
    expect(after.start_at).not.toBe(before.start_at);
  });

  await test.step("and every application-owned column is untouched", async () => {
    for (const column of APP_OWNED) {
      expect(
        after[column],
        `${column} was overwritten by the sync — the payload in ` +
          "src/app/api/calendar/sync/route.ts must not carry application-owned columns (CAR-175)",
      ).toEqual(before[column]);
    }
    // Spelled out as well as looped, so a failure names the actual value rather
    // than only the column.
    expect(after.source_gmail_thread_id).toBe(threadId);
    expect(after.source_gmail_message_id).toBe(messageId);
    expect(after.meeting_id).toBe(meetingId);
    expect(after.zoom_link).toBe(zoomLink);
  });
});
