import { describe, it, expect } from 'vitest';
import { buildOutreachQueue } from '@/lib/outreach-queue';
import type { CompanySummary } from '@/lib/company-queries';

const TODAY = '2026-07-07T12:00:00.000Z';

function company(overrides: Partial<CompanySummary> & { name: string }): CompanySummary {
  return {
    id: Math.floor(Math.random() * 100000),
    logo_url: null,
    linkedin_url: null,
    current_count: 2,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    office_scopes: [],
    traction: null,
    target: {
      id: 1,
      priority_score: 50,
      tier: null,
      program_name: null,
      app_window_text: null,
      next_app_date: null,
      status: 'researching',
    },
    ...overrides,
  };
}

function target(overrides: Partial<NonNullable<CompanySummary['target']>> = {}) {
  return {
    id: 1,
    priority_score: 50,
    tier: null,
    program_name: null,
    app_window_text: null,
    next_app_date: null,
    status: 'researching',
    ...overrides,
  };
}

describe('buildOutreachQueue', () => {
  it('includes only target companies with contactable people', () => {
    const { queue, skippedCount } = buildOutreachQueue(
      [
        company({ name: 'HasPeople' }),
        company({ name: 'BenchOnly', current_count: 0, former_count: 0, bench_count: 12 }),
        company({ name: 'Nobody', current_count: 0, former_count: 0 }),
        company({ name: 'NotTarget', target: null }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['HasPeople']);
    expect(skippedCount).toBe(2); // BenchOnly + Nobody (NotTarget was never a target)
  });

  it('excludes closed targets entirely (not counted as skipped)', () => {
    const { queue, skippedCount } = buildOutreachQueue(
      [
        company({ name: 'Open' }),
        company({ name: 'Closed', target: target({ status: 'closed' }) }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['Open']);
    expect(skippedCount).toBe(0);
  });

  it('former-only companies still qualify (past employees are contactable)', () => {
    const { queue } = buildOutreachQueue(
      [company({ name: 'FormerOnly', current_count: 0, former_count: 3 })],
      TODAY,
    );
    expect(queue).toHaveLength(1);
  });

  it('orders by priority desc, nulls last, name as tiebreak', () => {
    const { queue } = buildOutreachQueue(
      [
        company({ name: 'B-Low', target: target({ priority_score: 10 }) }),
        company({ name: 'NoScore', target: target({ priority_score: null }) }),
        company({ name: 'A-High', target: target({ priority_score: 90 }) }),
        company({ name: 'A-AlsoNoScore', target: target({ priority_score: null }) }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['A-High', 'B-Low', 'A-AlsoNoScore', 'NoScore']);
  });

  it('boosts companies with an app date within 30 days to the front, soonest first', () => {
    const { queue } = buildOutreachQueue(
      [
        company({ name: 'HighPriority', target: target({ priority_score: 99 }) }),
        company({ name: 'DeadlineLater', target: target({ priority_score: 5, next_app_date: '2026-07-20' }) }),
        company({ name: 'DeadlineSoon', target: target({ priority_score: 1, next_app_date: '2026-07-10' }) }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['DeadlineSoon', 'DeadlineLater', 'HighPriority']);
  });

  it('does not boost past dates or dates beyond the window', () => {
    const { queue } = buildOutreachQueue(
      [
        company({ name: 'HighPriority', target: target({ priority_score: 99 }) }),
        company({ name: 'PastDeadline', target: target({ priority_score: 5, next_app_date: '2026-07-01' }) }),
        company({ name: 'FarFuture', target: target({ priority_score: 10, next_app_date: '2026-12-01' }) }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['HighPriority', 'FarFuture', 'PastDeadline']);
  });

  it('a deadline exactly on the window edge is boosted', () => {
    const { queue } = buildOutreachQueue(
      [
        company({ name: 'HighPriority', target: target({ priority_score: 99 }) }),
        company({ name: 'EdgeOfWindow', target: target({ priority_score: 1, next_app_date: '2026-08-06' }) }),
      ],
      TODAY,
    );
    expect(queue[0].name).toBe('EdgeOfWindow');
  });
});
