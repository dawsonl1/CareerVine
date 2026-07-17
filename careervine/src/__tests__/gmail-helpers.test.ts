import { describe, it, expect } from 'vitest';
import { getHeader, parseEmailAddress, buildThreads, buildOwnAddressSet, ownAddressesFromConnection } from '@/lib/gmail-helpers';
import type { ParsedHeader } from '@/lib/gmail-helpers';
import type { EmailMessage } from '@/lib/types';

// buildThreads only reads six fields; cast a minimal shape rather than
// hand-building a full email_messages row.
function mkMsg(partial: Partial<EmailMessage>): EmailMessage {
  return partial as unknown as EmailMessage;
}

describe('getHeader', () => {
  const headers: ParsedHeader[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'To', value: 'bob@example.com' },
    { name: 'Subject', value: 'Hello World' },
    { name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' },
  ];

  it('finds header by exact name', () => {
    expect(getHeader(headers, 'From')).toBe('alice@example.com');
  });

  it('finds header case-insensitively', () => {
    expect(getHeader(headers, 'from')).toBe('alice@example.com');
    expect(getHeader(headers, 'FROM')).toBe('alice@example.com');
    expect(getHeader(headers, 'subject')).toBe('Hello World');
  });

  it('returns empty string for missing header', () => {
    expect(getHeader(headers, 'Cc')).toBe('');
    expect(getHeader(headers, 'Reply-To')).toBe('');
  });

  it('returns empty string for empty headers array', () => {
    expect(getHeader([], 'From')).toBe('');
  });

  it('returns first matching header', () => {
    const duped: ParsedHeader[] = [
      { name: 'X-Custom', value: 'first' },
      { name: 'X-Custom', value: 'second' },
    ];
    expect(getHeader(duped, 'X-Custom')).toBe('first');
  });
});

describe('parseEmailAddress', () => {
  it('extracts email from angle bracket format', () => {
    expect(parseEmailAddress('John Smith <john@example.com>')).toBe('john@example.com');
  });

  it('extracts email from complex display name', () => {
    expect(parseEmailAddress('"Smith, John" <john@example.com>')).toBe('john@example.com');
  });

  it('returns bare email as-is (lowercased)', () => {
    expect(parseEmailAddress('john@example.com')).toBe('john@example.com');
  });

  it('lowercases the result', () => {
    expect(parseEmailAddress('John@EXAMPLE.COM')).toBe('john@example.com');
    expect(parseEmailAddress('Alice <ALICE@Test.Com>')).toBe('alice@test.com');
  });

  it('trims whitespace', () => {
    expect(parseEmailAddress('  john@example.com  ')).toBe('john@example.com');
  });

  it('handles empty angle brackets gracefully (no match, falls back to raw)', () => {
    // <(.+?)> requires at least one char, so empty brackets don't match
    expect(parseEmailAddress('Name <>')).toBe('name <>');
  });

  it('handles nested angle brackets (takes first match)', () => {
    expect(parseEmailAddress('<first@test.com> and <second@test.com>')).toBe('first@test.com');
  });
});

describe('buildThreads', () => {
  it('groups messages that share a thread_id and orders messages oldest → newest', () => {
    const threads = buildThreads([
      mkMsg({ gmail_message_id: 'b', thread_id: 't1', subject: 'Hi', date: '2026-07-02T10:00:00Z', direction: 'inbound', matched_contact_id: 5 }),
      mkMsg({ gmail_message_id: 'a', thread_id: 't1', subject: 'Hi', date: '2026-07-01T10:00:00Z', direction: 'outbound', matched_contact_id: 5 }),
      mkMsg({ gmail_message_id: 'c', thread_id: 't1', subject: 'Hi', date: '2026-07-03T10:00:00Z', direction: 'inbound', matched_contact_id: 5 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((m) => m.gmail_message_id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts threads newest-first by their latest message date', () => {
    const threads = buildThreads([
      mkMsg({ gmail_message_id: 'old', thread_id: 't-old', subject: 'Old', date: '2026-01-01T00:00:00Z', direction: 'inbound', matched_contact_id: null }),
      mkMsg({ gmail_message_id: 'new', thread_id: 't-new', subject: 'New', date: '2026-07-01T00:00:00Z', direction: 'inbound', matched_contact_id: null }),
      mkMsg({ gmail_message_id: 'mid', thread_id: 't-mid', subject: 'Mid', date: '2026-04-01T00:00:00Z', direction: 'inbound', matched_contact_id: null }),
    ]);
    expect(threads.map((t) => t.threadId)).toEqual(['t-new', 't-mid', 't-old']);
  });

  it('derives subject and contactId from the earliest message, and latest fields from the newest', () => {
    const threads = buildThreads([
      mkMsg({ gmail_message_id: 'm2', thread_id: 't1', subject: 'Reply', date: '2026-07-02T10:00:00Z', direction: 'outbound', matched_contact_id: 9 }),
      mkMsg({ gmail_message_id: 'm1', thread_id: 't1', subject: 'First', date: '2026-07-01T10:00:00Z', direction: 'inbound', matched_contact_id: 7 }),
    ]);
    expect(threads[0].subject).toBe('First');
    expect(threads[0].contactId).toBe(7);
    expect(threads[0].latestDate).toBe('2026-07-02T10:00:00Z');
    expect(threads[0].latestDirection).toBe('outbound');
  });

  it('falls back to "(no subject)" when the first message has no subject', () => {
    const threads = buildThreads([
      mkMsg({ gmail_message_id: 'm1', thread_id: 't1', subject: null, date: '2026-07-01T10:00:00Z', direction: 'inbound', matched_contact_id: null }),
    ]);
    expect(threads[0].subject).toBe('(no subject)');
  });

  it('keys a message with no thread_id by its gmail_message_id', () => {
    const threads = buildThreads([
      mkMsg({ gmail_message_id: 'solo', thread_id: null, subject: 'Lonely', date: '2026-07-01T10:00:00Z', direction: 'inbound', matched_contact_id: null }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe('solo');
    expect(threads[0].messages).toHaveLength(1);
  });

  it('returns an empty array for no messages', () => {
    expect(buildThreads([])).toEqual([]);
  });
});

describe('buildOwnAddressSet (CAR-153/R2.5)', () => {
  it('lowercases and trims the primary plus aliases, deduped', () => {
    const set = buildOwnAddressSet(' Me@Gmail.COM ', ['me@gmail.com', ' Alias@X.dev ']);
    expect([...set].sort()).toEqual(['alias@x.dev', 'me@gmail.com']);
  });

  it('degrades to primary-only on null/malformed alias payloads (raw jsonb)', () => {
    expect([...buildOwnAddressSet('me@gmail.com', null)]).toEqual(['me@gmail.com']);
    expect([...buildOwnAddressSet('me@gmail.com', 'not-an-array')]).toEqual(['me@gmail.com']);
    expect([...buildOwnAddressSet('me@gmail.com', [42, null, ' '])]).toEqual(['me@gmail.com']);
  });

  it('ownAddressesFromConnection flattens the connection row', () => {
    expect(
      ownAddressesFromConnection({ gmail_address: 'Me@Gmail.com', send_as_aliases: ['alias@x.dev'] })
    ).toEqual(['me@gmail.com', 'alias@x.dev']);
    expect(ownAddressesFromConnection({ gmail_address: 'me@gmail.com' })).toEqual(['me@gmail.com']);
  });
});
