import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildMcpFollowUpRows, scheduleEmailSchema, followUpSequenceSchema } from "../tools/email";

/**
 * CAR-214: follow-ups can be queued in the same call as the opening email,
 * and they must land at a sane hour.
 *
 * The timing half is the regression that motivated this. buildFollowUpMessageRows
 * defaults to `setUTCHours(9,0,0,0)` — 09:00 **UTC**. The web callers pass a
 * browser timezone offset to correct it; MCP has no browser and never did, so
 * an intro timed for 9:00 a.m. Mountain produced follow-ups at 3:00 a.m.
 * Mountain. MCP steps now inherit the opening email's own time of day.
 */

const step = (send_after_days: number, subject = "Nudge") => ({
  subject,
  body: "Following up.",
  send_after_days,
});

describe("buildMcpFollowUpRows", () => {
  // 14:58 UTC = 08:58 Mountain (MDT). Nathan's real scheduled send.
  const SEND_AT = "2026-08-04T14:58:00.000Z";

  it("gives every step the opening email's time of day, not 09:00 UTC", () => {
    const rows = buildMcpFollowUpRows([step(6), step(14)], SEND_AT, SEND_AT);

    // The whole point: 14:58Z (≈9 a.m. Mountain), never 09:00Z (3 a.m. Mountain).
    expect(rows[0].scheduled_send_at).toBe("2026-08-10T14:58:00.000Z");
    expect(rows[1].scheduled_send_at).toBe("2026-08-18T14:58:00.000Z");
    for (const row of rows) {
      expect(row.scheduled_send_at.slice(11, 16)).not.toBe("09:00");
    }
  });

  it("offsets each step by its own send_after_days", () => {
    const rows = buildMcpFollowUpRows([step(1), step(3), step(30)], SEND_AT, SEND_AT);
    expect(rows.map((r) => r.scheduled_send_at.slice(0, 10))).toEqual([
      "2026-08-05",
      "2026-08-07",
      "2026-09-03",
    ]);
  });

  it("numbers steps from 1 and records the requested delay", () => {
    const rows = buildMcpFollowUpRows([step(6, "First"), step(14, "Second")], SEND_AT, SEND_AT);
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
    );
    expect(rows[0].scheduled_send_at).toBe("2026-08-05T16:30:00.000Z");
  });

  it("sanitizes step bodies on the way to storage", () => {
    // The cron auto-sends body_html verbatim, and MCP bodies come from an LLM.
    const rows = buildMcpFollowUpRows(
      [{ subject: "Hi", body: '<p>ok</p><script>fetch("https://evil")</script>', send_after_days: 1 }],
      SEND_AT,
      SEND_AT,
    );
    expect(rows[0].body_html).not.toContain("<script");
    expect(rows[0].body_html).toContain("ok");
  });

  it("converts markdown bodies to HTML", () => {
    const rows = buildMcpFollowUpRows(
      [{ subject: "Hi", body: "Still **interested**!", send_after_days: 1 }],
      SEND_AT,
      SEND_AT,
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
