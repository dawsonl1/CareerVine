import { describe, it, expect } from "vitest";
import { getContactStages, setCompanyQueriesClient } from "@/lib/company-queries";

/**
 * The DISTINCT conversation kinds behind a contact's call stages (CAR-267).
 *
 * CAR-257 taught the derivation the kind of the latest past / soonest upcoming
 * conversation; the per-contact chip row needs every distinct kind so a person
 * with a call and a text exchange gets both a "Call done" and a "Texted" chip.
 * These cases drive the real aggregation through the same tiny fake client as
 * contact-stages-reply-thread.test.ts, because the ordering and dedupe rules
 * live in the aggregation, not in a pure helper.
 */

const USER = "user-1";
const THEM = 42;

interface Mtg {
  id: number;
  date: string;
  type: string | null;
}

/** One junction row per meeting, shaped like the meeting_contacts leg's select. */
function meetingLink(m: Mtg) {
  return {
    meeting_id: m.id,
    contact_id: THEM,
    meetings: {
      user_id: USER,
      meeting_date: m.date,
      calendar_event_id: null,
      meeting_type: m.type,
    },
  };
}

function makeClient(rows: Record<string, Array<Record<string, unknown>>>) {
  function from(table: string) {
    const notNullCols: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "gte", "lt", "neq"]) {
      builder[m] = () => builder;
    }
    builder.not = (col: string) => {
      notNullCols.push(col);
      return builder;
    };
    builder.range = () => builder;
    builder.then = (resolve: (v: unknown) => void) => {
      let data = rows[table] ?? [];
      for (const col of notNullCols) data = data.filter((r) => r[col] != null);
      resolve({ data, error: null });
    };
    return builder;
  }
  setCompanyQueriesClient({ from } as unknown as Parameters<typeof setCompanyQueriesClient>[0]);
}

async function stagesFor(
  rows: Record<string, Array<Record<string, unknown>>>,
  stageOverride: string | null = null,
) {
  makeClient(rows);
  const stages = await getContactStages(USER, [{ id: THEM, stage_override: stageOverride }]);
  const s = stages.get(THEM);
  if (!s) throw new Error("no stage derived");
  return s;
}

/** A timestamp n days from now (negative = past), so cases do not rot. */
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

describe("getContactStages — distinct conversation kinds (CAR-267)", () => {
  it("reports a lone text meeting as kinds [text], not a call", async () => {
    const s = await stagesFor({
      meeting_contacts: [meetingLink({ id: 901, date: daysFromNow(-30), type: "text" })],
    });
    expect(s.stage).toBe("call_done");
    expect(s.conversations.past).toEqual({ kind: "text", kinds: ["text"], allCalls: false });
    expect(s.conversations.upcoming).toBeNull();
  });

  it("lists past kinds latest-first, kinds[0] matching kind", async () => {
    const s = await stagesFor({
      meeting_contacts: [
        meetingLink({ id: 901, date: daysFromNow(-40), type: "coffee" }),
        meetingLink({ id: 902, date: daysFromNow(-10), type: "text" }),
      ],
    });
    expect(s.conversations.past?.kind).toBe("text");
    expect(s.conversations.past?.kinds).toEqual(["text", "call"]);
    expect(s.conversations.past?.allCalls).toBe(false);
  });

  it("dedupes repeats of one kind while the tally keeps counting events", async () => {
    const s = await stagesFor({
      meeting_contacts: [
        meetingLink({ id: 901, date: daysFromNow(-20), type: "text" }),
        meetingLink({ id: 902, date: daysFromNow(-5), type: "text" }),
      ],
    });
    expect(s.conversations.past?.kinds).toEqual(["text"]);
    expect(s.tallies.call_done.count).toBe(2);
  });

  it("lists upcoming kinds soonest-first", async () => {
    const s = await stagesFor({
      meeting_contacts: [
        meetingLink({ id: 901, date: daysFromNow(3), type: "career-fair" }),
        meetingLink({ id: 902, date: daysFromNow(14), type: "coffee" }),
      ],
    });
    expect(s.stage).toBe("call_scheduled");
    expect(s.conversations.upcoming?.kind).toBe("career-fair");
    expect(s.conversations.upcoming?.kinds).toEqual(["career-fair", "call"]);
  });

  it("still resolves an untyped Google-synced event to a call", async () => {
    const s = await stagesFor({
      calendar_events: [
        {
          id: 700,
          google_event_id: "g-1",
          contact_id: THEM,
          start_at: daysFromNow(-7),
          status: "confirmed",
        },
      ],
    });
    expect(s.conversations.past).toEqual({ kind: "call", kinds: ["call"], allCalls: true });
  });

  it("keeps both sides null under a pure stage_override", async () => {
    const s = await stagesFor({}, "call_done");
    expect(s.stage).toBe("call_done");
    expect(s.conversations).toEqual({ past: null, upcoming: null });
  });
});
