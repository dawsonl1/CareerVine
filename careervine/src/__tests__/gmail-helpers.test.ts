import { describe, it, expect } from 'vitest';
import { getHeader, parseEmailAddress } from '@/lib/gmail-helpers';
import type { ParsedHeader } from '@/lib/gmail-helpers';

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
