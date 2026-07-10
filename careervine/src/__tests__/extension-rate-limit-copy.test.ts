import { describe, it, expect } from 'vitest';

// Panel-app modules imported via @panel alias (mirrors the @ext pattern)
import { isRateLimited, rateLimitedCopy } from '@panel/rate-limit-copy';
import { mapAiFailure } from '@panel/ai-failure';

describe('isRateLimited', () => {
  it('detects the API 429 rate_limited response', () => {
    expect(isRateLimited(429, 'rate_limited')).toBe(true);
  });

  it('requires both the 429 status and the rate_limited code', () => {
    expect(isRateLimited(402, 'rate_limited')).toBe(false);
    expect(isRateLimited(429, 'ai_unavailable')).toBe(false);
    expect(isRateLimited(429, undefined)).toBe(false);
    expect(isRateLimited(undefined, 'rate_limited')).toBe(false);
  });
});

describe('mapAiFailure vs rate limiting (CAR-41)', () => {
  it('is untouched by 429 — only 402 maps to an AI-availability failure', () => {
    expect(mapAiFailure(429, 'rate_limited')).toBeNull();
    expect(mapAiFailure(429, 'ai_unavailable')).toBeNull();
    expect(mapAiFailure(402, 'ai_no_key')).toBe('ai_no_key');
  });
});

describe('rateLimitedCopy', () => {
  const now = 1_000_000_000_000;

  it('computes minutes until reset, rounded up', () => {
    expect(rateLimitedCopy(now + 25 * 60_000, now)).toBe(
      "You've hit the hourly import limit — try again in 25 minutes.",
    );
    expect(rateLimitedCopy(now + 24.2 * 60_000, now)).toBe(
      "You've hit the hourly import limit — try again in 25 minutes.",
    );
  });

  it('never says fewer than 1 minute and singularizes it', () => {
    expect(rateLimitedCopy(now + 10_000, now)).toBe(
      "You've hit the hourly import limit — try again in 1 minute.",
    );
    expect(rateLimitedCopy(now - 5_000, now)).toBe(
      "You've hit the hourly import limit — try again in 1 minute.",
    );
  });

  it('falls back to generic wording when resetAt is missing or invalid', () => {
    const generic = "You've hit the hourly import limit — try again in a bit.";
    expect(rateLimitedCopy(null, now)).toBe(generic);
    expect(rateLimitedCopy(undefined, now)).toBe(generic);
    expect(rateLimitedCopy('soon', now)).toBe(generic);
    expect(rateLimitedCopy(NaN, now)).toBe(generic);
  });
});
