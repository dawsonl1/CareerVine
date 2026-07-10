import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (no top-level variable references in vi.mock factories) ─────

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({ __mockRedis: true })),
  },
}));

vi.mock('@upstash/ratelimit', () => {
  class MockRatelimit {
    static instances: MockRatelimit[] = [];
    static slidingWindow = vi.fn((limit: number, window: string) => ({ limit, window }));
    static limitMock = vi.fn();
    config: unknown;
    limit: typeof MockRatelimit.limitMock;
    constructor(config: unknown) {
      this.config = config;
      this.limit = MockRatelimit.limitMock;
      MockRatelimit.instances.push(this);
    }
  }
  return { Ratelimit: MockRatelimit };
});

import { Ratelimit } from '@upstash/ratelimit';
import { checkRateLimit, resetRateLimitersForTests } from '@/lib/rate-limit';

const MockRatelimit = Ratelimit as unknown as {
  instances: { config: { prefix: string } }[];
  slidingWindow: ReturnType<typeof vi.fn>;
  limitMock: ReturnType<typeof vi.fn>;
};

const OPTIONS = { bucket: 'test-bucket', limit: 10, window: '1 h' } as const;

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockRatelimit.instances.length = 0;
    resetRateLimitersForTests();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps a successful limit() call to allowed', async () => {
    MockRatelimit.limitMock.mockResolvedValue({ success: true, remaining: 7, reset: 1234567890 });

    const result = await checkRateLimit('user-1', OPTIONS);

    expect(result).toEqual({ allowed: true, remaining: 7, resetAt: 1234567890 });
    expect(MockRatelimit.limitMock).toHaveBeenCalledWith('user-1');
  });

  it('maps a denied limit() call to not allowed with resetAt', async () => {
    MockRatelimit.limitMock.mockResolvedValue({ success: false, remaining: 0, reset: 999 });

    const result = await checkRateLimit('user-1', OPTIONS);

    expect(result).toEqual({ allowed: false, remaining: 0, resetAt: 999 });
  });

  it('caches one Ratelimit instance per bucket, keyed by prefix', async () => {
    MockRatelimit.limitMock.mockResolvedValue({ success: true, remaining: 1, reset: 1 });

    await checkRateLimit('user-1', OPTIONS);
    await checkRateLimit('user-2', OPTIONS);
    await checkRateLimit('user-1', { bucket: 'other-bucket', limit: 5, window: '1 h' });

    expect(MockRatelimit.instances).toHaveLength(2);
    expect(MockRatelimit.instances.map((i) => i.config.prefix)).toEqual([
      'test-bucket',
      'other-bucket',
    ]);
    expect(MockRatelimit.slidingWindow).toHaveBeenCalledWith(10, '1 h');
    expect(MockRatelimit.slidingWindow).toHaveBeenCalledWith(5, '1 h');
  });

  it('allows everything (graceful no-op) when Upstash env vars are absent', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    resetRateLimitersForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checkRateLimit('user-1', OPTIONS);

    expect(result).toEqual({ allowed: true, remaining: OPTIONS.limit, resetAt: null });
    expect(MockRatelimit.instances).toHaveLength(0);
    expect(MockRatelimit.limitMock).not.toHaveBeenCalled();

    // Disabled state is logged once, not per call
    await checkRateLimit('user-1', OPTIONS);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });
});
