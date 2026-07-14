import { describe, it, expect } from "vitest";
import { resolveCalendarSaveMode } from "@/lib/calendar-save-mode";

describe("resolveCalendarSaveMode", () => {
  it("updates a linked meeting via existing path", () => {
    expect(
      resolveCalendarSaveMode({ hasLinkedMeeting: true, editingGoogleEventId: "g1" })
    ).toBe("update-linked");
  });

  it("PATCHes when editing a bare Google event", () => {
    expect(
      resolveCalendarSaveMode({
        hasLinkedMeeting: false,
        editingGoogleEventId: "google-abc",
      })
    ).toBe("patch-existing-google");
  });

  it("creates a new Google event only for brand-new meetings", () => {
    expect(
      resolveCalendarSaveMode({ hasLinkedMeeting: false, editingGoogleEventId: null })
    ).toBe("create-new");
  });
});
