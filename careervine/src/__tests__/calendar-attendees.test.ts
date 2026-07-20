/**
 * CAR-158: narrowing the jsonb `calendar_events.attendees` column.
 *
 * The column accepts anything, and rows predate the current writer, so the
 * parser's job is to be total: any input at all yields a valid attendee array.
 * The behaviour that matters is that one malformed entry costs that entry and
 * not the whole day's schedule.
 */

import { describe, it, expect } from "vitest";
import { parseCalendarAttendees } from "@/lib/calendar-attendees";

describe("parseCalendarAttendees", () => {
  it("parses well-formed attendees", () => {
    expect(
      parseCalendarAttendees([
        { email: "a@example.com", name: "Ada", responseStatus: "accepted" },
      ]),
    ).toEqual([{ email: "a@example.com", name: "Ada", responseStatus: "accepted" }]);
  });

  it("keeps email-only attendees, leaving optional fields undefined", () => {
    expect(parseCalendarAttendees([{ email: "a@example.com" }])).toEqual([
      { email: "a@example.com", name: undefined, responseStatus: undefined },
    ]);
  });

  it("drops entries with no usable email but keeps the rest", () => {
    const parsed = parseCalendarAttendees([
      { email: "keep@example.com" },
      { name: "no email" },
      { email: 42 },
      null,
      "a string",
      { email: "also-keep@example.com" },
    ]);
    expect(parsed.map((a) => a.email)).toEqual(["keep@example.com", "also-keep@example.com"]);
  });

  it("ignores non-string optional fields rather than passing them through", () => {
    expect(parseCalendarAttendees([{ email: "a@example.com", name: 7, responseStatus: {} }])).toEqual(
      [{ email: "a@example.com", name: undefined, responseStatus: undefined }],
    );
  });

  it("returns an empty array for anything that is not an array", () => {
    // jsonb legitimately holds null and scalars on older rows.
    for (const input of [null, undefined, {}, "", 0, "attendees"]) {
      expect(parseCalendarAttendees(input)).toEqual([]);
    }
  });
});
