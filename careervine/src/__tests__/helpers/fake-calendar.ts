/**
 * Fake Google Calendar API for calendar-sync tests (CAR-152).
 *
 * Implements the slice of `calendar.events.list` the ingestion path depends
 * on — pageToken pagination with nextSyncToken ONLY on the final page, sync
 * token requests, and 410 for expired tokens — so tests can drive the REAL
 * `fetchCalendarEvents` loop and the REAL route batching instead of mocking
 * `@/lib/calendar` away. Every call's params are recorded for assertions
 * (singleEvents / orderBy / token usage).
 *
 * Deliberately separate from the Gmail-ingestion ticket's fake-gmail helper.
 */

// Loose Google event shape — production code treats events as any (CAR-142).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
export type FakeCalendarEvent = Record<string, any>;

export interface FakeCalendarPage {
  items: FakeCalendarEvent[];
}

export interface FakeListParams {
  calendarId?: string;
  maxResults?: number;
  singleEvents?: boolean;
  orderBy?: string;
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  timeMax?: string;
}

export interface FakeCalendarApi {
  events: { list: (params: FakeListParams) => Promise<{ data: Record<string, unknown> }> };
  settings: { get: (params: { setting: string }) => Promise<{ data: { value: string } }> };
  calendarList: { list: () => Promise<{ data: { items: unknown[] } }> };
  /** Params of every events.list call, in order. */
  listCalls: FakeListParams[];
}

/**
 * Build a fake Calendar API that serves `pages` in order via pageToken
 * chaining. `nextSyncToken` is returned only with the final page, matching
 * Google's contract. When a request carries `syncToken`:
 *  - if it equals `expiredSyncToken`, the call rejects with { code: 410 };
 *  - otherwise the same pages are served (tests choose the page content to
 *    represent the incremental delta).
 */
export function createFakeCalendarApi(
  pages: FakeCalendarPage[],
  options: { nextSyncToken?: string; expiredSyncToken?: string } = {}
): FakeCalendarApi {
  const nextSyncToken = options.nextSyncToken ?? "sync-token-final";
  const listCalls: FakeListParams[] = [];

  const pageTokenFor = (index: number) => `page-${index}`;

  return {
    listCalls,
    events: {
      list: async (params: FakeListParams) => {
        listCalls.push({ ...params });

        if (params.syncToken && params.syncToken === options.expiredSyncToken) {
          throw Object.assign(new Error("Sync token is no longer valid"), { code: 410 });
        }

        const index = params.pageToken
          ? Number(params.pageToken.replace("page-", ""))
          : 0;
        const page = pages[index] ?? { items: [] };
        const isLast = index >= pages.length - 1;

        return {
          data: {
            items: page.items,
            ...(isLast ? { nextSyncToken } : { nextPageToken: pageTokenFor(index + 1) }),
          },
        };
      },
    },
    settings: {
      get: async () => ({ data: { value: "America/New_York" } }),
    },
    calendarList: {
      list: async () => ({ data: { items: [] } }),
    },
  };
}

/** A confirmed timed event with optional attendees. */
export function makeEvent(
  id: string,
  overrides: FakeCalendarEvent = {}
): FakeCalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: `Event ${id}`,
    start: { dateTime: "2026-07-10T15:00:00.000Z" },
    end: { dateTime: "2026-07-10T16:00:00.000Z" },
    ...overrides,
  };
}

/**
 * A single expanded instance of a recurring series, as `singleEvents: true`
 * returns them: id is `{seriesId}_{occurrenceTs}`, start/end are the REAL
 * occurrence times, and recurringEventId points at the series master.
 */
export function makeRecurringInstance(
  seriesId: string,
  occurrenceStartIso: string,
  overrides: FakeCalendarEvent = {}
): FakeCalendarEvent {
  const occurrenceTs = occurrenceStartIso.replace(/[-:.]/g, "").replace("000Z", "Z");
  const endIso = new Date(new Date(occurrenceStartIso).getTime() + 60 * 60 * 1000).toISOString();
  return {
    id: `${seriesId}_${occurrenceTs}`,
    status: "confirmed",
    summary: `Recurring ${seriesId}`,
    recurringEventId: seriesId,
    start: { dateTime: occurrenceStartIso },
    end: { dateTime: endIso },
    ...overrides,
  };
}

/**
 * A cancelled instance skeleton: status "cancelled", no start/end — the shape
 * Google sends for deleted occurrences and deleted events under singleEvents.
 */
export function makeCancelledInstance(
  id: string,
  overrides: FakeCalendarEvent = {}
): FakeCalendarEvent {
  return {
    id,
    status: "cancelled",
    ...overrides,
  };
}
