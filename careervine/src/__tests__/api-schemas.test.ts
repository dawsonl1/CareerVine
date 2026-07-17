import { describe, it, expect } from 'vitest';
import {
  gmailSendSchema,
  gmailFollowUpCreateSchema,
  gmailFollowUpUpdateSchema,
  calendarEventPatchSchema,
  calendarCreateEventSchema,
  contactsSearchQuerySchema,
  gmailDraftSchema,
  gmailScheduleCreateSchema,
  gmailEmailMoveSchema,
  calendarAvailabilityProfileSchema,
  calendarAvailabilityQuerySchema,
  calendarBusyCalendarsSchema,
  openaiKeySaveSchema,
  deepgramKeySaveSchema,
  extensionParseProfileSchema,
} from '@/lib/api-schemas';

// ── Helper ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
function expectValid(schema: any, data: unknown) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Expected valid but got: ${JSON.stringify(result.error.issues)}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
function expectInvalid(schema: any, data: unknown) {
  const result = schema.safeParse(data);
  expect(result.success).toBe(false);
}

// ── gmailSendSchema ────────────────────────────────────────────────────

describe('gmailSendSchema', () => {
  it('accepts valid send payload', () => {
    expectValid(gmailSendSchema, {
      to: 'alice@example.com',
      subject: 'Hello',
    });
  });

  it('accepts full payload with optional fields', () => {
    expectValid(gmailSendSchema, {
      to: 'alice@example.com',
      subject: 'Hello',
      cc: 'bob@example.com',
      bcc: 'carol@example.com',
      bodyHtml: '<p>Hi</p>',
      threadId: 'thread123',
      inReplyTo: '<msg@example.com>',
      references: '<ref@example.com>',
    });
  });

  it('rejects missing to', () => {
    expectInvalid(gmailSendSchema, { subject: 'Hello' });
  });

  it('rejects missing subject', () => {
    expectInvalid(gmailSendSchema, { to: 'alice@example.com' });
  });

  it('rejects empty to', () => {
    expectInvalid(gmailSendSchema, { to: '', subject: 'Hello' });
  });

  it('rejects empty subject', () => {
    expectInvalid(gmailSendSchema, { to: 'alice@example.com', subject: '' });
  });
});

// ── gmailFollowUpCreateSchema ──────────────────────────────────────────

describe('gmailFollowUpCreateSchema', () => {
  const validPayload = {
    originalGmailMessageId: 'msg123',
    threadId: 'thread456',
    recipientEmail: 'alice@example.com',
    originalSentAt: '2025-01-15T10:00:00Z',
    messages: [
      { sendAfterDays: 3, subject: 'Follow up', bodyHtml: '<p>Hi</p>' },
    ],
  };

  it('accepts valid payload', () => {
    expectValid(gmailFollowUpCreateSchema, validPayload);
  });

  it('accepts optional fields', () => {
    expectValid(gmailFollowUpCreateSchema, {
      ...validPayload,
      contactName: 'Alice',
      originalSubject: 'Re: Meeting',
      scheduledEmailId: 42,
    });
  });

  it('rejects empty messages array', () => {
    expectInvalid(gmailFollowUpCreateSchema, {
      ...validPayload,
      messages: [],
    });
  });

  it('rejects missing required fields', () => {
    expectInvalid(gmailFollowUpCreateSchema, {
      threadId: 'thread456',
      messages: [{ sendAfterDays: 3, subject: 'Hi', bodyHtml: '' }],
    });
  });
});

// ── gmailFollowUpUpdateSchema ──────────────────────────────────────────

describe('gmailFollowUpUpdateSchema', () => {
  it('accepts valid update payload', () => {
    expectValid(gmailFollowUpUpdateSchema, {
      messages: [
        { sendAfterDays: 5, subject: 'Updated', bodyHtml: '<p>New body</p>' },
      ],
    });
  });

  it('rejects empty messages', () => {
    expectInvalid(gmailFollowUpUpdateSchema, { messages: [] });
  });
});

// ── calendarEventPatchSchema ───────────────────────────────────────────

describe('calendarEventPatchSchema', () => {
  it('accepts a single field update', () => {
    expectValid(calendarEventPatchSchema, { summary: 'New title' });
  });

  it('accepts multiple fields', () => {
    expectValid(calendarEventPatchSchema, {
      summary: 'Updated',
      startTime: '2025-01-20T09:00:00Z',
      endTime: '2025-01-20T10:00:00Z',
    });
  });

  it('rejects empty object (at least one field required)', () => {
    expectInvalid(calendarEventPatchSchema, {});
  });
});

// ── calendarCreateEventSchema ──────────────────────────────────────────

describe('calendarCreateEventSchema', () => {
  it('accepts valid event', () => {
    expectValid(calendarCreateEventSchema, {
      summary: 'Coffee with Alice',
      startTime: '2025-01-20T09:00:00Z',
      endTime: '2025-01-20T10:00:00Z',
    });
  });

  it('accepts optional fields', () => {
    expectValid(calendarCreateEventSchema, {
      summary: 'Meeting',
      startTime: '2025-01-20T09:00:00Z',
      endTime: '2025-01-20T10:00:00Z',
      description: 'Discuss Q1 plans',
      attendeeEmails: ['alice@example.com'],
      conferenceType: 'meet',
      meetingId: 5,
    });
  });

  it('rejects missing summary', () => {
    expectInvalid(calendarCreateEventSchema, {
      startTime: '2025-01-20T09:00:00Z',
      endTime: '2025-01-20T10:00:00Z',
    });
  });

  it('rejects invalid conferenceType', () => {
    expectInvalid(calendarCreateEventSchema, {
      summary: 'Meeting',
      startTime: '2025-01-20T09:00:00Z',
      endTime: '2025-01-20T10:00:00Z',
      conferenceType: 'teams',
    });
  });
});

// ── contactsSearchQuerySchema ──────────────────────────────────────────

describe('contactsSearchQuerySchema', () => {
  it('accepts valid query', () => {
    expectValid(contactsSearchQuerySchema, { q: 'alice' });
  });

  it('rejects empty query', () => {
    expectInvalid(contactsSearchQuerySchema, { q: '' });
  });

  it('rejects missing q', () => {
    expectInvalid(contactsSearchQuerySchema, {});
  });
});

// ── gmailDraftSchema ───────────────────────────────────────────────────

describe('gmailDraftSchema', () => {
  it('accepts empty draft (all optional)', () => {
    expectValid(gmailDraftSchema, {});
  });

  it('accepts full draft', () => {
    expectValid(gmailDraftSchema, {
      id: 1,
      to: 'alice@example.com',
      subject: 'Draft subject',
      bodyHtml: '<p>Content</p>',
    });
  });
});

// ── gmailScheduleCreateSchema ──────────────────────────────────────────

describe('gmailScheduleCreateSchema', () => {
  it('accepts valid schedule', () => {
    expectValid(gmailScheduleCreateSchema, {
      to: 'alice@example.com',
      subject: 'Scheduled email',
      scheduledSendAt: '2025-02-01T09:00:00Z',
    });
  });

  it('rejects missing scheduledSendAt', () => {
    expectInvalid(gmailScheduleCreateSchema, {
      to: 'alice@example.com',
      subject: 'Scheduled email',
    });
  });
});

// ── gmailEmailMoveSchema ───────────────────────────────────────────────

describe('gmailEmailMoveSchema', () => {
  it('accepts valid labelId', () => {
    expectValid(gmailEmailMoveSchema, { labelId: 'INBOX' });
  });

  it('rejects empty labelId', () => {
    expectInvalid(gmailEmailMoveSchema, { labelId: '' });
  });
});

// ── calendarAvailabilityProfileSchema ──────────────────────────────────

describe('calendarAvailabilityProfileSchema', () => {
  it('accepts standard profile', () => {
    expectValid(calendarAvailabilityProfileSchema, {
      profile: 'standard',
      data: { windowStart: '09:00', windowEnd: '17:00' },
    });
  });

  it('accepts priority profile', () => {
    expectValid(calendarAvailabilityProfileSchema, {
      profile: 'priority',
      data: { duration: 60, bufferBefore: 15 },
    });
  });

  it('rejects invalid profile name', () => {
    expectInvalid(calendarAvailabilityProfileSchema, {
      profile: 'custom',
      data: {},
    });
  });

  // CAR-130: Settings / picker save workingDays; old schema stripped them to {}.
  it('preserves workingDays day configs (does not strip to empty data)', () => {
    const workingDays = [
      { day: 0, enabled: true, startTime: '09:00', endTime: '18:00', bufferBefore: 10, bufferAfter: 10 },
      { day: 1, enabled: false, startTime: '09:00', endTime: '18:00', bufferBefore: 10, bufferAfter: 10 },
    ];
    const result = calendarAvailabilityProfileSchema.safeParse({
      profile: 'standard',
      data: { workingDays },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.workingDays).toEqual(workingDays);
    }
  });
});

// ── followUpMessageSchema (via gmailFollowUpCreateSchema) ────────────

describe('followUpMessageSchema constraints', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  const wrap = (msg: any) => ({
    originalGmailMessageId: 'msg123',
    threadId: 'thread456',
    recipientEmail: 'alice@example.com',
    originalSentAt: '2025-01-15T10:00:00Z',
    messages: [msg],
  });

  it('rejects sendAfterDays of 0', () => {
    expectInvalid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 0, subject: 'Hi', bodyHtml: '',
    }));
  });

  it('rejects negative sendAfterDays', () => {
    expectInvalid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: -5, subject: 'Hi', bodyHtml: '',
    }));
  });

  it('rejects fractional sendAfterDays', () => {
    expectInvalid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 1.5, subject: 'Hi', bodyHtml: '',
    }));
  });

  it('accepts valid sendAfterDays', () => {
    expectValid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 3, subject: 'Hi', bodyHtml: '',
    }));
  });

  it('accepts valid sendTime in HH:MM format', () => {
    expectValid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 1, subject: 'Hi', bodyHtml: '', sendTime: '14:30',
    }));
  });

  it('accepts single-digit hour sendTime', () => {
    expectValid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 1, subject: 'Hi', bodyHtml: '', sendTime: '9:00',
    }));
  });

  it('rejects invalid sendTime format', () => {
    expectInvalid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 1, subject: 'Hi', bodyHtml: '', sendTime: 'morning',
    }));
  });

  it('rejects sendTime with extra segments', () => {
    expectInvalid(gmailFollowUpCreateSchema, wrap({
      sendAfterDays: 1, subject: 'Hi', bodyHtml: '', sendTime: '14:30:00',
    }));
  });
});

// ── calendarBusyCalendarsSchema ──────────────────────────────────────

describe('calendarBusyCalendarsSchema', () => {
  it('accepts array with calendar IDs', () => {
    expectValid(calendarBusyCalendarsSchema, {
      busyCalendarIds: ['primary', 'work@group.calendar.google.com'],
    });
  });

  it('accepts empty array (deselect all calendars)', () => {
    expectValid(calendarBusyCalendarsSchema, {
      busyCalendarIds: [],
    });
  });

  it('rejects missing busyCalendarIds', () => {
    expectInvalid(calendarBusyCalendarsSchema, {});
  });
});

// ── calendarAvailabilityQuerySchema ──────────────────────────────────

describe('calendarAvailabilityQuerySchema', () => {
  it('accepts required fields with numeric strings coerced to numbers', () => {
    const result = calendarAvailabilityQuerySchema.safeParse({
      start: '2026-03-20', end: '2026-03-27', duration: '30',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duration).toBe(30);
    }
  });

  it('rejects non-numeric duration string', () => {
    expectInvalid(calendarAvailabilityQuerySchema, {
      start: '2026-03-20', end: '2026-03-27', duration: 'abc',
    });
  });

  it('accepts when numeric params are omitted', () => {
    expectValid(calendarAvailabilityQuerySchema, {
      start: '2026-03-20', end: '2026-03-27',
    });
  });

  // CAR-129: Calendar page used to call /api/calendar/availability with no
  // params to detect connection; that 400 left calendarConnected false forever.
  it('rejects when start/end are missing (not a connection probe)', () => {
    expectInvalid(calendarAvailabilityQuerySchema, {});
  });
});

// ── openaiKeySaveSchema ────────────────────────────────────────────────

describe('openaiKeySaveSchema', () => {
  it('accepts a valid sk- key', () => {
    expectValid(openaiKeySaveSchema, { apiKey: 'sk-proj-abcdefghijklmnopqrst' });
  });

  it('rejects keys without sk- prefix', () => {
    expectInvalid(openaiKeySaveSchema, { apiKey: 'not-a-valid-openai-key' });
  });

  it('rejects keys that are too short', () => {
    expectInvalid(openaiKeySaveSchema, { apiKey: 'sk-short' });
  });

  it('does not echo the submitted key in error messages', () => {
    const result = openaiKeySaveSchema.safeParse({ apiKey: 'bad-key-value-12345' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).not.toContain('bad-key-value-12345');
    }
  });
});

// ── deepgramKeySaveSchema ──────────────────────────────────────────────

describe('deepgramKeySaveSchema', () => {
  const VALID = '0123456789abcdef0123456789abcdef01234567'; // 40 hex chars

  it('accepts a 40-character lowercase hex key', () => {
    expectValid(deepgramKeySaveSchema, { apiKey: VALID });
  });

  it('rejects an OpenAI-style sk- key', () => {
    expectInvalid(deepgramKeySaveSchema, { apiKey: 'sk-proj-abcdefghijklmnopqrst' });
  });

  it('rejects a key of the wrong length', () => {
    expectInvalid(deepgramKeySaveSchema, { apiKey: '0123456789abcdef' });
  });

  it('rejects a key with non-hex characters', () => {
    expectInvalid(deepgramKeySaveSchema, { apiKey: 'g'.repeat(40) });
  });

  it('does not echo the submitted key in error messages', () => {
    const result = deepgramKeySaveSchema.safeParse({ apiKey: 'ZZZ-secret-value-9999' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).not.toContain('ZZZ-secret-value-9999');
    }
  });
});

// ── extensionParseProfileSchema ────────────────────────────────────────

describe('extensionParseProfileSchema', () => {
  it('accepts typical cleaned profile text with a URL', () => {
    expectValid(extensionParseProfileSchema, {
      cleanedText: 'Jane Doe\nProduct Manager\nExperience\nAcme Corp',
      profileUrl: 'https://www.linkedin.com/in/janedoe/',
    });
  });

  it('accepts text without a profileUrl', () => {
    expectValid(extensionParseProfileSchema, { cleanedText: 'Jane Doe' });
  });

  it('rejects empty cleanedText', () => {
    expectInvalid(extensionParseProfileSchema, { cleanedText: '' });
  });

  it('accepts text at the 60k cap', () => {
    expectValid(extensionParseProfileSchema, { cleanedText: 'a'.repeat(60_000) });
  });

  it('rejects text over the 60k cap (cost guard)', () => {
    expectInvalid(extensionParseProfileSchema, { cleanedText: 'a'.repeat(60_001) });
  });
});

// ── CAR-143 (R5.1): CRLF rejection on header-bound strings ─────────────

describe('header-safe strings reject CR/LF (CAR-143)', () => {
  const INJECTED = 'Hello\r\nBcc: attacker@evil.com';

  it('gmailSendSchema rejects CRLF in to/subject/cc/bcc/threading headers', () => {
    const base = { to: 'a@example.com', subject: 'Hi' };
    expectValid(gmailSendSchema, base);
    expectInvalid(gmailSendSchema, { ...base, subject: INJECTED });
    expectInvalid(gmailSendSchema, { ...base, to: 'a@x.com\nBcc: e@e.com' });
    expectInvalid(gmailSendSchema, { ...base, cc: INJECTED });
    expectInvalid(gmailSendSchema, { ...base, bcc: INJECTED });
    expectInvalid(gmailSendSchema, { ...base, inReplyTo: '<id@x>\r\nX-Evil: 1' });
    expectInvalid(gmailSendSchema, { ...base, references: '<id@x>\nX-Evil: 1' });
  });

  it('gmailDraftSchema rejects CRLF in header-bound fields', () => {
    expectValid(gmailDraftSchema, { to: 'a@x.com', subject: 'Hi' });
    expectInvalid(gmailDraftSchema, { subject: INJECTED });
    expectInvalid(gmailDraftSchema, { to: 'a@x.com\r\nCc: e@e.com' });
  });

  it('gmailScheduleCreateSchema rejects CRLF in header-bound fields', () => {
    const base = { to: 'a@x.com', subject: 'Hi', scheduledSendAt: '2026-08-01T09:00:00Z' };
    expectValid(gmailScheduleCreateSchema, base);
    expectInvalid(gmailScheduleCreateSchema, { ...base, subject: INJECTED });
    expectInvalid(gmailScheduleCreateSchema, { ...base, bcc: INJECTED });
  });

  it('follow-up message subjects reject CRLF', () => {
    const base = {
      originalGmailMessageId: 'm1',
      threadId: 't1',
      recipientEmail: 'a@x.com',
      originalSentAt: '2026-07-01T12:00:00Z',
    };
    expectValid(gmailFollowUpCreateSchema, {
      ...base,
      messages: [{ sendAfterDays: 3, subject: 'Hi', bodyHtml: '<p>x</p>' }],
    });
    expectInvalid(gmailFollowUpCreateSchema, {
      ...base,
      messages: [{ sendAfterDays: 3, subject: INJECTED, bodyHtml: '<p>x</p>' }],
    });
    expectInvalid(gmailFollowUpCreateSchema, {
      ...base,
      recipientEmail: 'a@x.com\nBcc: e@e.com',
      messages: [{ sendAfterDays: 3, subject: 'Hi', bodyHtml: '<p>x</p>' }],
    });
    expectInvalid(gmailFollowUpUpdateSchema, {
      messages: [{ sendAfterDays: 3, subject: INJECTED, bodyHtml: '<p>x</p>' }],
    });
  });
});
