/**
 * Decide how calendar meeting form save should hit Google Calendar.
 * Kept pure so edit-without-duplicate behavior is unit-testable.
 */
export type CalendarSaveMode =
  | "update-linked"
  | "patch-existing-google"
  | "create-new";

export function resolveCalendarSaveMode(opts: {
  hasLinkedMeeting: boolean;
  editingGoogleEventId: string | null;
}): CalendarSaveMode {
  if (opts.hasLinkedMeeting) return "update-linked";
  if (opts.editingGoogleEventId) return "patch-existing-google";
  return "create-new";
}
