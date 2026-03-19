import { describe, it, expect } from 'vitest';
import { escapeIlikePattern } from '@/lib/search-helpers';

describe('escapeIlikePattern', () => {
  it('escapes percent signs', () => {
    expect(escapeIlikePattern('100%')).toBe('100\\%');
  });

  it('escapes underscores', () => {
    expect(escapeIlikePattern('john_doe')).toBe('john\\_doe');
  });

  it('escapes backslashes', () => {
    expect(escapeIlikePattern('O\\Brien')).toBe('O\\\\Brien');
  });

  it('escapes multiple special characters', () => {
    expect(escapeIlikePattern('%_test\\val_')).toBe('\\%\\_test\\\\val\\_');
  });

  it('leaves normal text unchanged', () => {
    expect(escapeIlikePattern('John Smith')).toBe('John Smith');
  });

  it('handles empty string', () => {
    expect(escapeIlikePattern('')).toBe('');
  });

  it('does not escape dots (unlike sanitizeForPostgrest)', () => {
    expect(escapeIlikePattern('J.R. Smith')).toBe('J.R. Smith');
  });

  it('does not escape parentheses', () => {
    expect(escapeIlikePattern('John (Johnny)')).toBe('John (Johnny)');
  });

  it('prevents wildcard injection', () => {
    // An attacker trying to match everything
    const result = escapeIlikePattern('%');
    expect(result).toBe('\\%');
    // When wrapped in %...%, this would become %\%% which matches literal %
  });
});
