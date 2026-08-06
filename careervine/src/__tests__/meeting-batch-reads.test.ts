/**
 * The activity timeline's per-meeting fan-out must stay dead (CAR-229).
 *
 * /meetings used to render its list by calling getActionItemsForMeeting,
 * getAttachmentsForMeeting and getTranscriptSegments once PER MEETING inside a
 * `Promise.all(meetings.map(...))`. getMeetings returns up to 200 rows, so that
 * is up to 600 concurrent PostgREST requests for one list; on a real account it
 * measured as 30 of the page's 40 requests.
 *
 * Two halves, because either alone is easy to defeat:
 *   1. the batched data functions issue ONE query per table regardless of how
 *      many meetings they are given (chunked only by the .in() limit), and
 *      group the rows back to exactly what the per-meeting call returned;
 *   2. the page does not reintroduce the fan-out — no per-meeting fetch may
 *      appear inside a `.map(` callback there, which is the shape the N+1 had.
 *
 * The queries are driven through the real setDataClient seam against the
 * recording client, so the filters and orders asserted here are the ones
 * PostgREST would receive.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
} from "../mcp/__tests__/helpers/recording-client";
import { setDataClient, type QueryClient } from "@/lib/data/client";
import { getActionItemsForMeetings } from "@/lib/data/action-items";
import { getAttachmentsForMeetings } from "@/lib/data/attachments";
import {
  getContactsByEmail,
  getFirstEmailByContactId,
  getTranscriptSegmentsForMeetings,
} from "@/lib/data/meetings";

const USER = "user-1";
const state = createRecordingState();

beforeEach(() => {
  state.recorded.length = 0;
  state.route = () => undefined;
  setDataClient(createRecordingClient(state) as unknown as QueryClient);
});

// The seam is a module-global singleton — restore the browser fallback so
// suites sharing this worker never see the recorder.
afterAll(() => setDataClient(null));

const on = (table: string): RecordedQuery[] => state.recorded.filter((q) => q.table === table);
const inFilter = (q: RecordedQuery) =>
  q.filters.find(([method]) => method === "in") as [string, string, unknown[]] | undefined;

describe("batched per-meeting reads issue one query, not one per meeting", () => {
  const meetingIds = Array.from({ length: 25 }, (_, i) => i + 1);

  it("getActionItemsForMeetings: one query over every id, grouped by meeting", async () => {
    state.route = (q) =>
      q.table === "follow_up_action_items"
        ? [
            { id: 1, meeting_id: 3, title: "a" },
            { id: 2, meeting_id: 3, title: "b" },
            { id: 9, meeting_id: 7, title: "c" },
            // meeting_id is nullable on the table; a grouped read must not
            // invent a `null` bucket out of one.
            { id: 12, meeting_id: null, title: "orphan" },
          ]
        : undefined;

    const byMeeting = await getActionItemsForMeetings(meetingIds);

    const queries = on("follow_up_action_items");
    expect(queries).toHaveLength(1);
    expect(inFilter(queries[0])).toEqual(["in", "meeting_id", meetingIds]);
    // chunkedPaginated's contract: a stable total order, meeting first so the
    // range windows can't straddle a group, then the per-meeting order the
    // singular function has always returned.
    expect(queries[0].orders).toEqual(["meeting_id", "id"]);

    expect(Object.keys(byMeeting)).toEqual(["3", "7"]);
    expect(byMeeting[3].map((r) => r.id)).toEqual([1, 2]);
    expect(byMeeting[7].map((r) => r.id)).toEqual([9]);
  });

  it("getAttachmentsForMeetings: one query over every id, unwrapped to attachments", async () => {
    state.route = (q) =>
      q.table === "meeting_attachments"
        ? [
            { meeting_id: 3, attachment_id: 50, attachments: { id: 50, file_name: "a.pdf" } },
            { meeting_id: 3, attachment_id: 51, attachments: { id: 51, file_name: "b.pdf" } },
            // A junction row whose attachment was deleted embeds null; it must
            // be dropped, not pushed as an undefined entry.
            { meeting_id: 4, attachment_id: 52, attachments: null },
          ]
        : undefined;

    const byMeeting = await getAttachmentsForMeetings(meetingIds);

    const queries = on("meeting_attachments");
    expect(queries).toHaveLength(1);
    expect(inFilter(queries[0])).toEqual(["in", "meeting_id", meetingIds]);
    expect(queries[0].orders).toEqual(["meeting_id", "attachment_id"]);

    expect(Object.keys(byMeeting)).toEqual(["3"]);
    expect(byMeeting[3].map((a) => a.file_name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("getTranscriptSegmentsForMeetings: one query over every id, ordered within a meeting", async () => {
    state.route = (q) =>
      q.table === "transcript_segments"
        ? [
            { id: 1, meeting_id: 3, ordinal: 0, content: "hi" },
            { id: 2, meeting_id: 3, ordinal: 1, content: "there" },
            { id: 3, meeting_id: 8, ordinal: 0, content: "elsewhere" },
          ]
        : undefined;

    const byMeeting = await getTranscriptSegmentsForMeetings(meetingIds);

    const queries = on("transcript_segments");
    expect(queries).toHaveLength(1);
    expect(inFilter(queries[0])).toEqual(["in", "meeting_id", meetingIds]);
    expect(queries[0].orders).toEqual(["meeting_id", "ordinal"]);
    expect(byMeeting[3].map((s) => s.content)).toEqual(["hi", "there"]);
  });

  it("issues nothing at all for an empty meeting list", async () => {
    await getActionItemsForMeetings([]);
    await getAttachmentsForMeetings([]);
    await getTranscriptSegmentsForMeetings([]);
    expect(state.recorded).toHaveLength(0);
  });

  it("chunks the .in() list rather than growing the URL without bound", async () => {
    // 450 ids → 3 chunks of 200/200/50, NOT 450 queries and NOT one URL
    // carrying 450 ids. chunkedPaginated also pages each chunk's response,
    // which is what makes it safe on a table that fans out per meeting.
    await getActionItemsForMeetings(Array.from({ length: 450 }, (_, i) => i + 1));
    const queries = on("follow_up_action_items");
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => inFilter(q)![2].length)).toEqual([200, 200, 50]);
  });
});

describe("attendee identity lookups are bounded by what is on screen", () => {
  it("getFirstEmailByContactId keys on the contact ids given, scoped and status-filtered", async () => {
    state.route = (q) =>
      q.table === "contact_emails"
        ? [
            { contact_id: 4, email: "first@example.com" },
            { contact_id: 4, email: "second@example.com" },
            { contact_id: 9, email: null },
          ]
        : undefined;

    const byContact = await getFirstEmailByContactId(USER, [4, 9, 4]);

    const queries = on("contact_emails");
    expect(queries).toHaveLength(1);
    // Deduped, and never a whole-table read.
    expect(inFilter(queries[0])).toEqual(["in", "contact_id", [4, 9]]);
    // The lookup replaced a getContacts() call, whose default excludes bench —
    // widening this would start labelling attendees the page never labelled.
    expect(queries[0].filters).toContainEqual(["eq", "contacts.user_id", USER]);
    expect(queries[0].filters).toContainEqual(["in", "contacts.network_status", ["active", "prospect"]]);
    // A filter on an embedded column only restricts parent rows under !inner.
    expect(queries[0].selectCols).toContain("contacts!inner");

    // "First" is what the old contact_emails[0] read resolved to, and a null
    // address is skipped rather than claiming an empty one.
    expect(byContact.get(4)).toBe("first@example.com");
    expect(byContact.has(9)).toBe(false);
  });

  it("getContactsByEmail lowercases the addresses it is handed", async () => {
    state.route = (q) =>
      q.table === "contact_emails"
        ? [{ email: "jane@example.com", contacts: { id: 7, name: "Jane Doe" } }]
        : undefined;

    const byEmail = await getContactsByEmail(USER, ["  Jane@Example.com ", "JANE@EXAMPLE.COM", ""]);

    const queries = on("contact_emails");
    expect(queries).toHaveLength(1);
    // contact_emails.email is stored lower(trim())-normalized, but the calendar
    // attendee addresses this is called with come straight from Google.
    expect(inFilter(queries[0])).toEqual(["in", "email", ["jane@example.com"]]);
    expect(queries[0].filters).toContainEqual(["eq", "contacts.user_id", USER]);
    expect(queries[0].filters).toContainEqual(["in", "contacts.network_status", ["active", "prospect"]]);
    expect(byEmail.get("jane@example.com")).toEqual({ id: 7, name: "Jane Doe" });
  });

  it("issues nothing when nothing on screen needs resolving", async () => {
    await getFirstEmailByContactId(USER, []);
    await getContactsByEmail(USER, ["", "   "]);
    expect(state.recorded).toHaveLength(0);
  });
});

/** The balanced `(...)` span each occurrence of `open` starts. */
function balancedSpans(src: string, open: string): string[] {
  const spans: string[] = [];
  for (let i = src.indexOf(open); i !== -1; i = src.indexOf(open, i + 1)) {
    let depth = 0;
    for (let j = i + open.length - 1; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) {
        spans.push(src.slice(i, j + 1));
        break;
      }
    }
  }
  return spans;
}

/**
 * The two spellings the fan-out can take: a `Promise.all(...)` over a mapped
 * list, and an `async` map callback. Deliberately NOT every `.map(` — the JSX
 * that renders the timeline is one enormous map, and the event handlers inside
 * it legitimately fetch for the single meeting the user acted on. Flagging
 * those would make the guard unusable, which is how guards get deleted.
 */
function fanOutSpans(src: string): string[] {
  return [...balancedSpans(src, "Promise.all("), ...balancedSpans(src, ".map(async")];
}

describe("the activity page does not reintroduce the per-meeting fan-out", () => {
  const PAGE = join(process.cwd(), "src/app/meetings/page.tsx");
  const src = readFileSync(PAGE, "utf8");

  it("calls the batched readers", () => {
    expect(src).toContain("getActionItemsForMeetings(");
    expect(src).toContain("getAttachmentsForMeetings(");
    expect(src).toContain("getTranscriptSegmentsForMeetings(");
  });

  it("never fetches per meeting from inside a fan-out", () => {
    // The singular readers still have legitimate single-meeting call sites (a
    // refresh after a mutation) — what must never come back is one of them
    // reached once per row.
    const perMeeting = ["getActionItemsForMeeting(", "getAttachmentsForMeeting(", "getTranscriptSegments("];
    const offenders = fanOutSpans(src).flatMap((span) =>
      perMeeting.filter((fn) => span.includes(fn)).map((fn) => `${fn} inside ${span.slice(0, 70)}…`),
    );
    expect(offenders).toEqual([]);
  });

  it("the guard above can actually see the fan-out it forbids", () => {
    // Falsification: the exact shape CAR-229 removed, run through the same
    // detector. Without this the test above passes on any source at all — the
    // way an assertion of absence usually fails, silently.
    const reintroduced = `
      await Promise.all(data.map(async (m) => {
        const [items, atts] = await Promise.all([
          getActionItemsForMeeting(m.id),
          getAttachmentsForMeeting(m.id),
        ]);
      }));`;
    const seen = fanOutSpans(reintroduced).some((span) => span.includes("getActionItemsForMeeting("));
    expect(seen).toBe(true);
  });

  it("does not load the full contact list as part of the page load", () => {
    // getContacts stays imported — the ContactPicker and the speaker resolver
    // genuinely need every contact — but only behind ensureAllContacts(), which
    // a user interaction triggers.
    expect(src).toContain("const ensureAllContacts = useCallback");
    const mountEffect = src.slice(src.indexOf("useEffect(() => {\n    if (user) {"));
    expect(mountEffect.slice(0, mountEffect.indexOf("}, [")))
      .not.toContain("ensureAllContacts");
    expect(src.match(/getContacts\(/g) ?? []).toHaveLength(1);
  });
});
