import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { buildMcpFollowUpRows, scheduleEmailSchema, followUpSequenceSchema } from "../tools/email";

/**
 * CAR-214: follow-ups can be queued in the same call as the opening email,
 * and they must land at a sane hour.
 *
 * The timing half is the regression that motivated this. buildFollowUpMessageRows
 * used to default to `setUTCHours(9,0,0,0)` — 09:00 **UTC** — so an intro timed
 * for 9:00 a.m. Mountain produced follow-ups at 3:00 a.m. Mountain. MCP steps
 * inherit the opening email's own time of day instead.
 *
 * CAR-215 then fixed the same bug at the root: `sendTime` is now LOCAL to a real
 * IANA zone rather than UTC, and the anchor is read in that zone. The
 * expectations below are unchanged by that, because Denver is on one offset
 * across all these dates — which is the point. The two cases at the bottom cover
 * where the approaches actually diverge.
 */

/** Mountain wall clock at an instant, computed independently of the code under test. */
const localClock = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Denver",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const step = (send_after_days: number, subject = "Nudge") => ({
  subject,
  body: "Following up.",
  send_after_days,
});

describe("buildMcpFollowUpRows", () => {
  // 14:58 UTC = 08:58 Mountain (MDT). Nathan's real scheduled send.
  const SEND_AT = "2026-08-04T14:58:00.000Z";
  const MT = "America/Denver";

  /**
   * Pin the clock two minutes after SEND_AT.
   *
   * Every expectation below is a date relative to these fixtures, and the
   * builder's future-floor (CAR-220) rewrites any step that lands in the past.
   * Against a live clock these assertions were therefore true only until the
   * calendar reached the fixtures and then failed forever: on 2026-08-05 the
   * `send_after_days: 1` step and the historical-thread case both started
   * clamping a day forward. Freezing the clock is what makes the suite a test
   * of the arithmetic rather than of the date it runs on.
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every step the opening email's time of day, not 09:00 UTC", () => {
    const rows = buildMcpFollowUpRows([step(6), step(14)], SEND_AT, SEND_AT, MT);

    // The whole point: 14:58Z (≈9 a.m. Mountain), never 09:00Z (3 a.m. Mountain).
    expect(rows[0].scheduled_send_at).toBe("2026-08-10T14:58:00.000Z");
    expect(rows[1].scheduled_send_at).toBe("2026-08-18T14:58:00.000Z");
    for (const row of rows) {
      expect(row.scheduled_send_at.slice(11, 16)).not.toBe("09:00");
    }
  });

  it("offsets each step by its own send_after_days", () => {
    const rows = buildMcpFollowUpRows([step(1), step(3), step(30)], SEND_AT, SEND_AT, MT);
    expect(rows.map((r) => r.scheduled_send_at.slice(0, 10))).toEqual([
      "2026-08-05",
      "2026-08-07",
      "2026-09-03",
    ]);
  });

  it("numbers steps from 1 and records the requested delay", () => {
    const rows = buildMcpFollowUpRows([step(6, "First"), step(14, "Second")], SEND_AT, SEND_AT, MT);
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2]);
    expect(rows.map((r) => r.send_after_days)).toEqual([6, 14]);
    expect(rows.map((r) => r.subject)).toEqual(["First", "Second"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("takes the day from the date base but the clock from the time anchor", () => {
    // The historical-thread path: the original went out weeks ago, so the day
    // base is clamped to now to stop the cron firing the whole sequence at
    // once — but the time of day should still be the conversation's own.
    const rows = buildMcpFollowUpRows(
      [step(2)],
      "2026-08-03T23:40:00.000Z", // clamped-to-now base, late at night
      "2026-06-01T16:30:00.000Z", // original send, 16:30Z
      MT,
    );
    expect(rows[0].scheduled_send_at).toBe("2026-08-05T16:30:00.000Z");
  });

  it("sanitizes step bodies on the way to storage", () => {
    // The cron auto-sends body_html verbatim, and MCP bodies come from an LLM.
    const rows = buildMcpFollowUpRows(
      [{ subject: "Hi", body: '<p>ok</p><script>fetch("https://evil")</script>', send_after_days: 1 }],
      SEND_AT,
      SEND_AT,
      MT,
    );
    expect(rows[0].body_html).not.toContain("<script");
    expect(rows[0].body_html).toContain("ok");
  });

  /**
   * The merge hazard, pinned. CAR-214 read the anchor's UTC hour; CAR-215 made
   * `sendTime` mean local. Keeping both as-is would have fed a UTC hour to a
   * local-interpreting builder and shifted every MCP follow-up by the user's
   * whole offset. This asserts the anchor is read in the user's zone.
   */
  it("reads the anchor's hour in the user's zone, not UTC", () => {
    // 20:00Z is 14:00 Mountain. Follow-ups must land at 14:00 Mountain (20:00Z),
    // NOT at 20:00 Mountain (02:00Z the next day), which is what a UTC-read
    // anchor would have produced once sendTime became local.
    const rows = buildMcpFollowUpRows([step(7)], "2026-08-04T20:00:00.000Z", "2026-08-04T20:00:00.000Z", MT);
    expect(rows[0].scheduled_send_at).toBe("2026-08-11T20:00:00.000Z");
    expect(localClock(rows[0].scheduled_send_at)).toBe("14:00");
  });

  it("holds the local hour across a DST boundary, where a UTC anchor drifts", () => {
    // Anchor 2026-10-15 15:05Z = 09:05 MDT. The step lands 2026-11-05, after the
    // Nov 1 fall-back. Pinning the local wall clock keeps it at 09:05 Mountain;
    // pinning 15:05Z would have shown 08:05 Mountain, an hour earlier than the
    // conversation's own hour.
    const rows = buildMcpFollowUpRows([step(21)], "2026-10-15T15:05:00.000Z", "2026-10-15T15:05:00.000Z", MT);
    expect(localClock(rows[0].scheduled_send_at)).toBe("09:05");
    expect(rows[0].scheduled_send_at).toBe("2026-11-05T16:05:00.000Z");
  });

  it("converts markdown bodies to HTML", () => {
    const rows = buildMcpFollowUpRows(
      [{ subject: "Hi", body: "Still **interested**!", send_after_days: 1 }],
      SEND_AT,
      SEND_AT,
      MT,
    );
    expect(rows[0].body_html).toContain("<strong>interested</strong>");
  });
});

describe("schedule_email follow_ups schema", () => {
  const schema = z.object(scheduleEmailSchema);
  const base = { name: "Nathan", subject: "Hi", body: "Hello", send_at: "2026-08-04T14:58:00Z" };

  it("accepts a scheduled email with its follow-ups in one call", () => {
    const parsed = schema.parse({ ...base, follow_ups: [step(6), step(14)] });
    expect(parsed.follow_ups).toHaveLength(2);
  });

  it("still accepts a bare scheduled email", () => {
    expect(schema.parse(base).follow_ups).toBeUndefined();
  });

  it("rejects a step with no delay, which would fire the moment the intro sends", () => {
    expect(() => schema.parse({ ...base, follow_ups: [{ ...step(1), send_after_days: 0 }] })).toThrow();
  });

  it("rejects a subject with a line break (MIME header injection)", () => {
    expect(() =>
      schema.parse({ ...base, follow_ups: [{ ...step(1), subject: "Hi\r\nBcc: evil@example.com" }] }),
    ).toThrow();
  });

  it("caps the sequence length", () => {
    expect(() => schema.parse({ ...base, follow_ups: Array.from({ length: 6 }, () => step(1)) })).toThrow();
  });
});

describe("create_follow_up_sequence anchors", () => {
  const schema = z.object(followUpSequenceSchema);

  it("accepts a pending scheduled email as the anchor", () => {
    const parsed = schema.parse({ name: "Nathan", scheduled_email_id: 12, messages: [step(6)] });
    expect(parsed.scheduled_email_id).toBe(12);
  });

  it("still accepts the already-sent thread anchors", () => {
    expect(schema.parse({ name: "N", thread_id: "t1", messages: [step(6)] }).thread_id).toBe("t1");
    expect(
      schema.parse({ name: "N", original_message_id: "m1", messages: [step(6)] }).original_message_id,
    ).toBe("m1");
  });
});
