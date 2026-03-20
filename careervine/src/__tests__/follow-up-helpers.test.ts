import { describe, it, expect } from 'vitest';
import { buildFollowUpMessageRows } from '@/lib/follow-up-helpers';
import { FollowUpMessageStatus } from '@/lib/constants';

describe('buildFollowUpMessageRows', () => {
  const baseDate = new Date('2025-01-15T10:00:00Z');

  it('builds rows with correct sequence numbers starting at 1', () => {
    const rows = buildFollowUpMessageRows(
      42,
      [
        { sendAfterDays: 3, subject: 'First', bodyHtml: '<p>Hi</p>' },
        { sendAfterDays: 7, subject: 'Second', bodyHtml: '<p>Following up</p>' },
      ],
      baseDate,
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
      2, // 2 messages already sent
    );

    expect(rows[0].sequence_number).toBe(3);
  });

  it('schedules dates relative to sentAt + sendAfterDays', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 5, subject: 'Test', bodyHtml: '' }],
      baseDate,
    );

    const scheduled = new Date(rows[0].scheduled_send_at);
    // Should be 5 days after baseDate, defaulting to 9:00 AM UTC
    expect(scheduled.getUTCDate()).toBe(baseDate.getUTCDate() + 5);
    expect(scheduled.getUTCHours()).toBe(9);
    expect(scheduled.getUTCMinutes()).toBe(0);
  });

  it('uses sendTime when provided instead of 9:00 default', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [{ sendAfterDays: 1, subject: 'Test', bodyHtml: '', sendTime: '14:30' }],
      baseDate,
    );

    const scheduled = new Date(rows[0].scheduled_send_at);
    expect(scheduled.getUTCHours()).toBe(14);
    expect(scheduled.getUTCMinutes()).toBe(30);
  });

  it('sets all rows to pending status', () => {
    const rows = buildFollowUpMessageRows(
      1,
      [
        { sendAfterDays: 1, subject: 'A', bodyHtml: '' },
        { sendAfterDays: 3, subject: 'B', bodyHtml: '' },
      ],
      baseDate,
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
    );

    expect(rows[0].subject).toBe('Check in');
    expect(rows[0].body_html).toBe('<b>Hello</b>');
    expect(rows[0].send_after_days).toBe(1);
  });

  it('returns empty array for empty messages', () => {
    const rows = buildFollowUpMessageRows(1, [], baseDate);
    expect(rows).toEqual([]);
  });
});
