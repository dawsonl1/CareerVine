import { describe, it, expect } from "vitest";
import {
  matchSpeakerToAttendee,
  resolveDueDate,
} from "@/lib/transcript-action-helpers";

describe("matchSpeakerToAttendee", () => {
  const attendees = [
    { id: 1, name: "John Smith" },
    { id: 2, name: "Jane Doe" },
    { id: 3, name: "Alex Johnson" },
  ];

  it("matches exact name", () => {
    expect(matchSpeakerToAttendee("John Smith", attendees)).toEqual({ id: 1, name: "John Smith" });
  });

  it("matches case-insensitively", () => {
    expect(matchSpeakerToAttendee("john smith", attendees)).toEqual({ id: 1, name: "John Smith" });
  });

  it("matches by first name", () => {
    expect(matchSpeakerToAttendee("Jane", attendees)).toEqual({ id: 2, name: "Jane Doe" });
  });

  it("matches by last name", () => {
    expect(matchSpeakerToAttendee("Johnson", attendees)).toEqual({ id: 3, name: "Alex Johnson" });
  });

  it("returns null for no match", () => {
    expect(matchSpeakerToAttendee("Bob", attendees)).toBeNull();
  });

  it("returns null for empty attendees", () => {
    expect(matchSpeakerToAttendee("John", [])).toBeNull();
  });

  it("returns null for empty speaker", () => {
    expect(matchSpeakerToAttendee("", attendees)).toBeNull();
  });

  it("does not match single-letter first names", () => {
    const atts = [{ id: 1, name: "J. Smith" }];
    expect(matchSpeakerToAttendee("J", atts)).toBeNull();
  });

  it("matches by email in speaker label", () => {
    const atts = [
      { id: 1, name: "John Smith", email: "john@example.com" },
      { id: 2, name: "Jane Doe", emails: ["jane@example.com", "jdoe@work.com"] },
    ];
    expect(matchSpeakerToAttendee("john@example.com", atts)).toEqual({ id: 1, name: "John Smith", email: "john@example.com" });
  });

  it("matches email from emails array", () => {
    const atts = [
      { id: 1, name: "Jane Doe", emails: ["jane@example.com", "jdoe@work.com"] },
    ];
    expect(matchSpeakerToAttendee("jdoe@work.com", atts)).toEqual({ id: 1, name: "Jane Doe", emails: ["jane@example.com", "jdoe@work.com"] });
  });

  it("matches email embedded in longer label", () => {
    const atts = [
      { id: 1, name: "John Smith", email: "john@example.com" },
    ];
    expect(matchSpeakerToAttendee("John (john@example.com)", atts)).toEqual({ id: 1, name: "John Smith", email: "john@example.com" });
  });

  it("does not match when email does not match any contact", () => {
    const atts = [
      { id: 1, name: "John Smith", email: "john@example.com" },
    ];
    expect(matchSpeakerToAttendee("unknown@other.com", atts)).toBeNull();
  });
});

describe("resolveDueDate", () => {
  // Use a Wednesday as the base date
  const meetingDate = "2026-03-18T10:00:00Z"; // Wednesday

  it("returns null for null hint", () => {
    expect(resolveDueDate(null, meetingDate)).toBeNull();
  });

  it("returns null for unparseable hint", () => {
    expect(resolveDueDate("whenever you get a chance", meetingDate)).toBeNull();
  });

  it("resolves 'tomorrow'", () => {
    expect(resolveDueDate("tomorrow", meetingDate)).toBe("2026-03-19");
  });

  it("resolves 'today'", () => {
    expect(resolveDueDate("today", meetingDate)).toBe("2026-03-18");
  });

  it("resolves 'by Friday'", () => {
    expect(resolveDueDate("by Friday", meetingDate)).toBe("2026-03-20");
  });

  it("resolves 'next Monday'", () => {
    expect(resolveDueDate("next Monday", meetingDate)).toBe("2026-03-30");
  });

  it("resolves 'next week'", () => {
    // Next Monday from Wednesday March 18
    expect(resolveDueDate("next week", meetingDate)).toBe("2026-03-23");
  });

  it("resolves 'end of month'", () => {
    expect(resolveDueDate("end of month", meetingDate)).toBe("2026-03-31");
  });

  it("resolves 'in 3 days'", () => {
    expect(resolveDueDate("in 3 days", meetingDate)).toBe("2026-03-21");
  });

  it("resolves 'in 2 weeks'", () => {
    expect(resolveDueDate("in 2 weeks", meetingDate)).toBe("2026-04-01");
  });

  it("resolves 'end of week'", () => {
    expect(resolveDueDate("end of week", meetingDate)).toBe("2026-03-20");
  });

  it("resolves 'end of week' on a Friday to that same Friday", () => {
    expect(resolveDueDate("end of week", "2026-03-20")).toBe("2026-03-20");
  });

  it("resolves 'this week' on a Friday to that same Friday", () => {
    expect(resolveDueDate("this week", "2026-03-20")).toBe("2026-03-20");
  });

  it("resolves 'next month'", () => {
    expect(resolveDueDate("next month", meetingDate)).toBe("2026-04-01");
  });

  it("returns null for invalid meeting date", () => {
    expect(resolveDueDate("tomorrow", "not-a-date")).toBeNull();
  });
});
