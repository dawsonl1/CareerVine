import { describe, it, expect } from 'vitest';
import { calculateNameMatchConfidence } from '@/lib/duplicate-helpers';

describe('calculateNameMatchConfidence', () => {
  it('returns 90 for exact match', () => {
    expect(calculateNameMatchConfidence('John Smith', 'John Smith')).toBe(90);
  });

  it('returns 90 for case-insensitive exact match', () => {
    expect(calculateNameMatchConfidence('john smith', 'John Smith')).toBe(90);
  });

  it('returns 80 for both first and last matching (non-exact)', () => {
    expect(calculateNameMatchConfidence('John Smith', 'John D Smith')).toBe(80);
  });

  it('returns partial confidence for first name only match', () => {
    const score = calculateNameMatchConfidence('John Smith', 'John Doe');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(80);
  });

  it('returns partial confidence for last name only match', () => {
    const score = calculateNameMatchConfidence('Jane Smith', 'John Smith');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(80);
  });

  it('returns 0 for completely different names', () => {
    expect(calculateNameMatchConfidence('John Smith', 'Alice Cooper')).toBe(0);
  });

  it('handles substring matching (Bob matches Bobby)', () => {
    const score = calculateNameMatchConfidence('Bob Smith', 'Bobby Smith');
    expect(score).toBeGreaterThan(50);
  });

  it('filters out single-character name parts', () => {
    // "J" is filtered out, so only "Smith" matches
    const score = calculateNameMatchConfidence('J Smith', 'John Smith');
    // "J" is filtered (length <= 1), so searchNames = ["smith"], existingNames = ["john","smith"]
    // 1 match / max(1,2) = 0.5 * 80 = 40
    expect(score).toBe(40);
  });

  it('caps at 90 even for exact match', () => {
    expect(calculateNameMatchConfidence('John Smith', 'John Smith')).toBeLessThanOrEqual(90);
  });

  it('handles names with middle names', () => {
    const score = calculateNameMatchConfidence('John Michael Smith', 'John Smith');
    // searchNames = ["john","michael","smith"], existingNames = ["john","smith"]
    // 2 matches (john, smith) / max(3,2) = 2/3 * 80 ≈ 53.3
    expect(score).toBeGreaterThan(50);
  });

  it('handles hyphenated last names via substring', () => {
    const score = calculateNameMatchConfidence('Jane Johnson', 'Jane Johnson-Williams');
    // "johnson" includes "johnson" → match. "jane" matches "jane" → match
    // 2/2 * 80 = 80, not exact match
    expect(score).toBe(80);
  });
});
