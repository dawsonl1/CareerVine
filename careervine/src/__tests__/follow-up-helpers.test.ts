import { describe, it, expect } from 'vitest';
import { buildFollowUpMessageRows, reconcileFollowUpEditStatuses } from '@/lib/follow-up-helpers';
import { FollowUpMessageStatus } from '@/lib/constants';

describe('buildFollowUpMessageRows', () => {
  const baseDate = new Date('2025-01-15T10:00:00Z');
  const MT = 'America/Denver';

  /** Wall clock the given zone shows at an instant, independent of the code under test. */
  const wallClockIn = (iso: string, zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));

  it('builds rows with correct sequence numbers starting at 1', () => {
    const rows = buildFollowUpMessageRows(
      42,
      [
        { sendAfterDays: 3, subject: 'First', bodyHtml: '<p>Hi</p>' },
        { sendAfterDays: 7, subject: 'Second', bodyHtml: '<p>Following up</p>' },
      ],
      baseDate,
      MT,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].sequence_number).toBe(1);
    expect(rows[1].sequence_number).toBe(2);
    expect(rows[0].follow_up_id).toBe(42);
    expect(rows[1].follow_up_id).toBe(42);
  });

  it('offsets sequence numbers when sequenceOffset is provided', () => {
    const rows = buildFollowUpMessageRows(
      42,
      [
        { sendAfterDays: 3, subject: 'Third', bodyHtml: '<p>Hey</p>' },
      ],
      baseDate,
      MT,
      2, // 2 messages already sent
    );

    expect(rows[0].sequence_number).toBe(3);
  });

  /**
   * CAR-215. This used to assert `getUTCHours() === 9`, encoding the bug: the
   * builder called setUTCHours(9, 0), so every follow-up went out at 09:00 UTC,
   * which is 2:00 AM for a Mountain user. The default is now 9:05 LOCAL.
   */
  it('defaults to 9:05 in the user\'s own zone, not 9:00 UTC', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 5, subject: 'Test', bodyHtml: '' }],
      baseDate,
      MT,
    );

    // 2025-01-15 + 5 days = 2025-01-20, at 09:05 Mountain (MST, UTC-7).
    expect(wallClockIn(rows[0].scheduled_send_at, MT)).toBe('2025-01-20, 09:05');
    expect(rows[0].scheduled_send_at).toBe('2025-01-20T16:05:00.000Z');
    // The old behaviour would have been 09:00Z, i.e. 02:00 local. Guard it.
    expect(new Date(rows[0].scheduled_send_at).getUTCHours()).not.toBe(9);
  });

  it('gives each zone its own local 9:05', () => {
    const forZone = (zone: string) =>
      buildFollowUpMessageRows(1, [{ sendAfterDays: 5, subject: 'T', bodyHtml: '' }], baseDate, zone)[0]
        .scheduled_send_at;

    expect(forZone('America/New_York')).toBe('2025-01-20T14:05:00.000Z');
    expect(forZone(MT)).toBe('2025-01-20T16:05:00.000Z');
    expect(forZone('America/Los_Angeles')).toBe('2025-01-20T17:05:00.000Z');
    // UTC is the honest fallback when the zone is unknown.
    expect(forZone('UTC')).toBe('2025-01-20T09:05:00.000Z');
  });

  it('treats a caller-picked sendTime as local, not UTC', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 1, subject: 'Test', bodyHtml: '', sendTime: '14:30' }],
      baseDate,
      MT,
    );

    // Picking 14:30 in the follow-up modal must mean 14:30 where the user is.
    expect(wallClockIn(rows[0].scheduled_send_at, MT)).toBe('2025-01-16, 14:30');
  });

  it('ignores an out-of-range sendTime rather than rolling the date', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 1, subject: 'Test', bodyHtml: '', sendTime: '99:99' }],
      baseDate,
      MT,
    );

    expect(wallClockIn(rows[0].scheduled_send_at, MT)).toBe('2025-01-16, 09:05');
  });

  it('holds the local hour across a DST boundary', () => {
    // Created 2026-10-15 (MDT); the 21-day step lands 2026-11-05, past the
    // Nov 1 fall-back. A creation-time offset would have made this 08:05.
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 21, subject: 'Late step', bodyHtml: '' }],
      new Date('2026-10-15T15:05:00Z'),
      MT,
    );

    expect(wallClockIn(rows[0].scheduled_send_at, MT)).toBe('2026-11-05, 09:05');
  });

  it('sets all rows to pending status', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [
        { sendAfterDays: 1, subject: 'A', bodyHtml: '' },
        { sendAfterDays: 3, subject: 'B', bodyHtml: '' },
      ],
      baseDate,
      MT,
    );

    for (const row of rows) {
      expect(row.status).toBe(FollowUpMessageStatus.Pending);
    }
  });

  it('preserves subject and body_html from input', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 1, subject: 'Check in', bodyHtml: '<b>Hello</b>' }],
      baseDate,
      MT,
    );

    expect(rows[0].subject).toBe('Check in');
    expect(rows[0].body_html).toBe('<b>Hello</b>');
    expect(rows[0].send_after_days).toBe(1);
  });

  it('returns empty array for empty messages', () => {
    const rows = buildFollowUpMessageRows(1, [], baseDate, MT);
    expect(rows).toEqual([]);
  });
});

describe('reconcileFollowUpEditStatuses', () => {
  const baseRow = {
    follow_up_id: 1,
    sequence_number: 1,
    send_after_days: 7,
    status: FollowUpMessageStatus.Pending,
    scheduled_send_at: '2026-07-20T09:00:00Z',
    subject: 'Edited subject',
    body_html: '<p>Edited</p>',
  };

  it('keeps awaiting_review + park metadata when delay is unchanged', () => {
    const prior = new Map([
      [
        1,
        {
          sequence_number: 1,
          send_after_days: 7,
          status: FollowUpMessageStatus.AwaitingReview,
          parked_at: '2026-07-14T09:00:00Z',
          expires_at: '2026-07-28T09:00:00Z',
          reminder_count: 1,
          last_reminder_at: '2026-07-15T09:00:00Z',
          seen_during_window: true,
        },
      ],
    ]);

    const [row] = reconcileFollowUpEditStatuses([baseRow], prior);
    expect(row.status).toBe(FollowUpMessageStatus.AwaitingReview);
    expect(row.parked_at).toBe('2026-07-14T09:00:00Z');
    expect(row.expires_at).toBe('2026-07-28T09:00:00Z');
    expect(row.reminder_count).toBe(1);
    expect(row.subject).toBe('Edited subject');
  });

  it('keeps expired when delay is unchanged', () => {
    const prior = new Map([
      [
        1,
        {
          sequence_number: 1,
          send_after_days: 7,
          status: FollowUpMessageStatus.Expired,
          parked_at: '2026-07-01T09:00:00Z',
          expires_at: '2026-07-14T09:00:00Z',
          reminder_count: 2,
          last_reminder_at: null,
          seen_during_window: false,
        },
      ],
    ]);

    const [row] = reconcileFollowUpEditStatuses([baseRow], prior);
    expect(row.status).toBe(FollowUpMessageStatus.Expired);
    expect(row.expires_at).toBe('2026-07-14T09:00:00Z');
  });

  it('resets to pending when delay changes', () => {
    const prior = new Map([
      [
        1,
        {
          sequence_number: 1,
          send_after_days: 7,
          status: FollowUpMessageStatus.AwaitingReview,
          parked_at: '2026-07-14T09:00:00Z',
          expires_at: '2026-07-28T09:00:00Z',
          reminder_count: 1,
          last_reminder_at: null,
          seen_during_window: false,
        },
      ],
    ]);

    const [row] = reconcileFollowUpEditStatuses(
      [{ ...baseRow, send_after_days: 10 }],
      prior,
    );
    expect(row.status).toBe(FollowUpMessageStatus.Pending);
    expect(row.parked_at).toBeUndefined();
  });

  it('leaves pending steps pending', () => {
    const prior = new Map([
      [
        1,
        {
          sequence_number: 1,
          send_after_days: 7,
          status: FollowUpMessageStatus.Pending,
          parked_at: null,
          expires_at: null,
          reminder_count: 0,
          last_reminder_at: null,
          seen_during_window: false,
        },
      ],
    ]);

    const [row] = reconcileFollowUpEditStatuses([baseRow], prior);
    expect(row.status).toBe(FollowUpMessageStatus.Pending);
  });
});
