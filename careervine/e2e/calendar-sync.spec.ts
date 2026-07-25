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
 * payload without those four keys (route.ts:231-238), and PostgREST's
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
 * Two of the four have no writer anywhere in the app today (`meeting_id` and
 * `zoom_link` are set by no route), so the service client seeds all four
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
    .update({ calendar_scopes_granted: false, calendar_last_synced_at: null })
    .eq("user_id", userId);
  if (error) throw new Error(`revoking calendar scope: ${error.message}`);
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

  await test.step("seed the event with all four application-owned columns set", async () => {
    // Upsert, not insert: `/` also fires a background sync, so this row may
    // already exist from an earlier navigation in this run. Upserting on the
    // same natural key the sync route uses converges from either state.
    const { error } = await serviceClient()
      .from("calendar_events")
      .upsert(
        {
          user_id: userId,
          google_event_id: E2E_CALENDAR_EVENT_ID,
          calendar_id: "primary",
          // Deliberately stale and wrong: the sync must overwrite both.
          title: "STALE TITLE — the sync must replace this",
          start_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 + 1800_000).toISOString(),
          // Every real writer (sync, create-event, the MCP tool) stores an
          // array, so seeding one keeps this row shaped like production data.
          // Leaving it null is what first exposed the unguarded `.length` on
          // the calendar page, now normalized in /api/calendar/events.
          attendees: [],
          source_gmail_thread_id: threadId,
          source_gmail_message_id: messageId,
          meeting_id: meeting.id,
          zoom_link: zoomLink,
        },
        { onConflict: "user_id,google_event_id" },
      );
    if (error) throw new Error(`seeding calendar event: ${error.message}`);
  });

  const before = await readEvent(userId);

  await test.step("sync from the calendar page", async () => {
    await page.goto("/calendar");
    // The explicit button, not the background auto-sync on mount: it passes
    // `force=true`, which drops the cooldown from 5 minutes to 5 seconds, and
    // it is the path that reports failure rather than swallowing it.
    await page.getByRole("button", { name: "Sync" }).click();

    // The sync is what advances `synced_at`, and it completes server-side after
    // the click resolves. Polling the column is how this waits on it without
    // guessing a duration.
    await expect
      .poll(async () => (await readEvent(userId)).synced_at, {
        message:
          "synced_at never advanced — the sync did not write. Check calendar_scopes_granted " +
          "and that the stub's event falls inside the timeMin/timeMax window.",
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
    expect(after.meeting_id).toBe(meeting.id);
    expect(after.zoom_link).toBe(zoomLink);
  });
});
