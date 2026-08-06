import { describe, it, expect } from "vitest";
import { clampFollowUpInstants, parseSendTime, shiftLocalDate } from "@/lib/follow-up-helpers";
import { rescheduleFollowUpSequenceCascade } from "@/lib/data/emails";

/**
 * CAR-230: retime an active sequence's remaining steps without touching copy.
 *
 * The invariants under test are the ones a second hand-rolled writer would drop.
 * `clampFollowUpInstants` is now the single authority for them, shared with the
 * creation path, so these cases guard both callers.
 */

const MT = "America/Denver";
/** Mountain wall clock at an instant, computed independently of the code under test. */
const localClock = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: MT,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
const localDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: MT, dateStyle: "short" }).format(d);

describe("parseSendTime", () => {
  it("reads a real HH:MM", () => {
    expect(parseSendTime("09:03")).toEqual({ hour: 9, minute: 3 });
    expect(parseSendTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseSendTime("0:07")).toEqual({ hour: 0, minute: 7 });
  });

  it("falls back to the default rather than rolling the date on nonsense", () => {
    // The danger is not a wrong hour, it is that hour=99 pushes
    // zonedWallClockToUtc onto another DAY, silently moving the step.
    for (const bad of ["99:99", "24:00", "12:60", "", "not-a-time", undefined]) {
      expect(parseSendTime(bad)).toEqual({ hour: 9, minute: 5 });
    }
  });
});

describe("shiftLocalDate", () => {
  it("rolls month and year on overflow", () => {
    expect(shiftLocalDate({ year: 2026, month: 8, day: 20 }, 21)).toEqual({
      year: 2026,
      month: 9,
      day: 10,
    });
    expect(shiftLocalDate({ year: 2026, month: 12, day: 28 }, 5)).toEqual({
      year: 2027,
      month: 1,
      day: 2,
    });
  });
});

describe("clampFollowUpInstants", () => {
  const now = new Date("2026-08-05T20:00:00.000Z"); // 14:00 Mountain

  it("leaves a future instant exactly where it was asked for", () => {
    const [got] = clampFollowUpInstants(
      [{ localDate: { year: 2026, month: 8, day: 7 }, hour: 9, minute: 3 }],
      MT,
      now,
    );
    expect(localDay(got)).toBe("2026-08-07");
    expect(localClock(got)).toBe("09:03");
  });

  it("advances a past instant by whole local days, keeping the requested clock", () => {
    // 09:03 Mountain today already passed at 14:00. The user asked for 09:03,
    // so 09:03 tomorrow honours that where "now" would not.
    const [got] = clampFollowUpInstants(
      [{ localDate: { year: 2026, month: 8, day: 5 }, hour: 9, minute: 3 }],
      MT,
      now,
    );
    expect(localDay(got)).toBe("2026-08-06");
    expect(localClock(got)).toBe("09:03");
    expect(got.getTime()).toBeGreaterThan(now.getTime());
  });

  it("keeps steps strictly increasing when several clamp at once", () => {
    // Without the running floor these three collapse onto one instant and the
    // contact gets three emails simultaneously.
    const got = clampFollowUpInstants(
      [
        { localDate: { year: 2026, month: 7, day: 1 }, hour: 9, minute: 3 },
        { localDate: { year: 2026, month: 7, day: 2 }, hour: 9, minute: 3 },
        { localDate: { year: 2026, month: 7, day: 3 }, hour: 9, minute: 3 },
      ],
      MT,
      now,
    );
    expect(got[0].getTime()).toBeGreaterThan(now.getTime());
    expect(got[1].getTime()).toBeGreaterThan(got[0].getTime());
    expect(got[2].getTime()).toBeGreaterThan(got[1].getTime());
    expect(new Set(got.map((d) => d.getTime())).size).toBe(3);
    for (const d of got) expect(localClock(d)).toBe("09:03");
  });

  it("holds the local wall clock across a DST boundary", () => {
    // 2026-11-01 is the US fall-back. A step on either side must still read
    // 09:03 locally; pinning a UTC instant instead would slide it an hour.
    const got = clampFollowUpInstants(
      [
        { localDate: { year: 2026, month: 10, day: 30 }, hour: 9, minute: 3 },
        { localDate: { year: 2026, month: 11, day: 3 }, hour: 9, minute: 3 },
      ],
      MT,
      now,
    );
    expect(got.map(localClock)).toEqual(["09:03", "09:03"]);
    expect(got.map(localDay)).toEqual(["2026-10-30", "2026-11-03"]);
  });

  it("clears a floor months in the past without looping a day at a time", () => {
    const [got] = clampFollowUpInstants(
      [{ localDate: { year: 2025, month: 2, day: 14 }, hour: 9, minute: 3 }],
      MT,
      now,
    );
    expect(got.getTime()).toBeGreaterThan(now.getTime());
    expect(localClock(got)).toBe("09:03");
  });
});

/**
 * Cascade tests run against a hand-rolled stub rather than a live Supabase:
 * what matters here is the FILTER SET on each query (ownership, active-only,
 * unresolved-only), and a stub is the only way to assert those directly.
 */
type Row = Record<string, unknown>;

function makeClient(opts: {
  parent: Row | null;
  steps: Row[];
}) {
  const calls: { table: string; filters: Record<string, unknown>; payload?: Row }[] = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    let payload: Row | undefined;
    const self: Record<string, unknown> = {};
    const chain = (k: string) => (col: string, val: unknown) => {
      filters[`${k}:${col}`] = val;
      return self;
    };
    Object.assign(self, {
      select: () => self,
      order: () => self,
      range: () => self,
      eq: chain("eq"),
      in: chain("in"),
      update: (p: Row) => {
        payload = p;
        return self;
      },
      maybeSingle: async () => {
        calls.push({ table, filters, payload });
        return { data: opts.parent, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        calls.push({ table, filters, payload });
        const isStepRead = table === "email_follow_up_messages" && payload === undefined;
        return Promise.resolve(
          resolve({ data: isStepRead ? opts.steps : null, error: null }),
        );
      },
    });
    return self;
  };

  return { client: { from: builder } as never, calls };
}

describe("rescheduleFollowUpSequenceCascade", () => {
  const now = new Date("2026-08-05T20:00:00.000Z");

  it("returns null when the sequence is not this user's or not active", async () => {
    const { client, calls } = makeClient({ parent: null, steps: [] });
    const got = await rescheduleFollowUpSequenceCascade(client, "user-1", 35, "09:03", MT, now);

    expect(got).toBeNull();
    // Ownership and active-ness are enforced in the query, not in JS after the
    // fact: the service role bypasses RLS, so a missing filter here would make
    // another user's sequence writable.
    expect(calls[0].filters).toMatchObject({
      "eq:id": 35,
      "eq:user_id": "user-1",
      "eq:status": "active",
    });
    // Nothing was written.
    expect(calls.every((c) => c.payload === undefined)).toBe(true);
  });

  it("writes only scheduled_send_at, keeping each step's calendar date", async () => {
    const { client, calls } = makeClient({
      parent: { id: 35 },
      steps: [
        { id: 1, sequence_number: 1, scheduled_send_at: "2026-08-07T22:39:00.000Z" },
        { id: 2, sequence_number: 2, scheduled_send_at: "2026-08-12T22:39:00.000Z" },
      ],
    });

    const got = await rescheduleFollowUpSequenceCascade(client, "user-1", 35, "09:03", MT, now);

    expect(got).toEqual([
      { sequenceNumber: 1, scheduledSendAt: expect.any(String) },
      { sequenceNumber: 2, scheduledSendAt: expect.any(String) },
    ]);
    // Same days as before, new clock.
    expect(got!.map((s) => localDay(new Date(s.scheduledSendAt)))).toEqual([
      "2026-08-07",
      "2026-08-12",
    ]);
    expect(got!.map((s) => localClock(new Date(s.scheduledSendAt)))).toEqual(["09:03", "09:03"]);

    // The copy is never in the payload — that is the whole reason this path
    // exists instead of the rebuild-from-caller-copy PUT route.
    const writes = calls.filter((c) => c.payload !== undefined);
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(Object.keys(w.payload!)).toEqual(["scheduled_send_at"]);
    }
  });

  it("re-asserts unresolved status on the write so a claimed step is not moved", async () => {
    const { client, calls } = makeClient({
      parent: { id: 35 },
      steps: [{ id: 1, sequence_number: 1, scheduled_send_at: "2026-08-07T22:39:00.000Z" }],
    });

    await rescheduleFollowUpSequenceCascade(client, "user-1", 35, "09:03", MT, now);

    const write = calls.find((c) => c.payload !== undefined)!;
    // A row the send driver claimed into 'sending' between the read and this
    // write must not be retimed out from under the send in flight.
    expect(write.filters["in:status"]).not.toContain("sending");
    expect(write.filters["in:status"]).toContain("pending");
    expect(write.filters["eq:id"]).toBe(1);
  });

  it("reports an empty move when nothing is left to reschedule", async () => {
    const { client } = makeClient({ parent: { id: 35 }, steps: [] });
    await expect(
      rescheduleFollowUpSequenceCascade(client, "user-1", 35, "09:03", MT, now),
    ).resolves.toEqual([]);
  });

  it("pushes a step to the next day when the requested time already passed", async () => {
    const { client } = makeClient({
      parent: { id: 35 },
      // Due TODAY, and 09:03 Mountain is already behind the 14:00 clock.
      steps: [{ id: 1, sequence_number: 1, scheduled_send_at: "2026-08-05T22:39:00.000Z" }],
    });

    const got = await rescheduleFollowUpSequenceCascade(client, "user-1", 35, "09:03", MT, now);

    expect(localDay(new Date(got![0].scheduledSendAt))).toBe("2026-08-06");
    expect(new Date(got![0].scheduledSendAt).getTime()).toBeGreaterThan(now.getTime());
  });

  /**
   * CAR-232: a map gives the steps of one sequence different times of day.
   *
   * The scenario these were written from is real: a three-step sequence sitting
   * at one time, wanted at 11:05 / 10:22 / 09:03. Before this the only way to
   * get there was to re-apply the single-string form between firings from
   * outside the app, which meant the tail silently kept the old time whenever
   * that outside process did not run.
   */
  describe("per-step times", () => {
    /** Aug 11 / 14 / 19, all at 11:05 Mountain. */
    const threeSteps = [
      { id: 1, sequence_number: 1, scheduled_send_at: "2026-08-11T17:05:00.000Z" },
      { id: 2, sequence_number: 2, scheduled_send_at: "2026-08-14T17:05:00.000Z" },
      { id: 3, sequence_number: 3, scheduled_send_at: "2026-08-19T17:05:00.000Z" },
    ];

    it("moves only the sequence numbers the map names", async () => {
      const { client } = makeClient({ parent: { id: 35 }, steps: threeSteps });

      const got = await rescheduleFollowUpSequenceCascade(
        client,
        "user-1",
        35,
        new Map([
          [2, "10:22"],
          [3, "9:03"],
        ]),
        MT,
        now,
      );

      // Step 1 is absent from the map, so it keeps the clock it already had
      // rather than inheriting a neighbour's.
      expect(got!.map((s) => localClock(new Date(s.scheduledSendAt)))).toEqual([
        "11:05",
        "10:22",
        "09:03",
      ]);
      // Dates are untouched, same as the single-string form.
      expect(got!.map((s) => localDay(new Date(s.scheduledSendAt)))).toEqual([
        "2026-08-11",
        "2026-08-14",
        "2026-08-19",
      ]);
    });

    it("keeps a decreasing clock strictly increasing in absolute time", async () => {
      const { client } = makeClient({ parent: { id: 35 }, steps: threeSteps });

      const got = await rescheduleFollowUpSequenceCascade(
        client,
        "user-1",
        35,
        new Map([
          [1, "11:05"],
          [2, "10:22"],
          [3, "9:03"],
        ]),
        MT,
        now,
      );

      const instants = got!.map((s) => new Date(s.scheduledSendAt).getTime());
      expect(instants[1]).toBeGreaterThan(instants[0]);
      expect(instants[2]).toBeGreaterThan(instants[1]);
    });

    it("still writes nothing but scheduled_send_at", async () => {
      const { client, calls } = makeClient({ parent: { id: 35 }, steps: threeSteps });

      await rescheduleFollowUpSequenceCascade(client, "user-1", 35, new Map([[2, "10:22"]]), MT, now);

      const writes = calls.filter((c) => c.payload !== undefined);
      // Every unresolved step is rewritten, including the ones keeping their
      // clock: the clamp runs over the whole ordered set, so the write set is
      // deliberately not narrowed to the named steps.
      expect(writes).toHaveLength(3);
      for (const w of writes) {
        expect(Object.keys(w.payload!)).toEqual(["scheduled_send_at"]);
      }
    });

    it("clamps a mapped time that has already passed, like the string form", async () => {
      const { client } = makeClient({
        parent: { id: 35 },
        // Due TODAY; 09:03 Mountain is behind the 14:00 clock.
        steps: [{ id: 1, sequence_number: 1, scheduled_send_at: "2026-08-05T22:39:00.000Z" }],
      });

      const got = await rescheduleFollowUpSequenceCascade(
        client,
        "user-1",
        35,
        new Map([[1, "9:03"]]),
        MT,
        now,
      );

      expect(localDay(new Date(got![0].scheduledSendAt))).toBe("2026-08-06");
      expect(new Date(got![0].scheduledSendAt).getTime()).toBeGreaterThan(now.getTime());
    });

    it("is a no-op for a map that names no remaining step", async () => {
      const { client } = makeClient({ parent: { id: 35 }, steps: threeSteps });

      const got = await rescheduleFollowUpSequenceCascade(
        client,
        "user-1",
        35,
        new Map([[99, "9:03"]]),
        MT,
        now,
      );

      // Every step kept its own clock and date.
      expect(got!.map((s) => localClock(new Date(s.scheduledSendAt)))).toEqual([
        "11:05",
        "11:05",
        "11:05",
      ]);
      expect(got!.map((s) => s.scheduledSendAt)).toEqual(
        threeSteps.map((s) => s.scheduled_send_at),
      );
    });
  });
});
