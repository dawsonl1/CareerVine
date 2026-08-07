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
    traction_detail: null,
    lead_detail: null,
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
  it('includes only target companies with someone working there now', () => {
    const { queue, skippedCount } = buildOutreachQueue(
      [
        company({ name: 'HasPeople' }),
        company({ name: 'BenchOnly', current_count: 0, former_count: 0, bench_count: 12 }),
        company({ name: 'Nobody', current_count: 0, former_count: 0 }),
        company({ name: 'AllLeft', current_count: 0, former_count: 8 }),
        company({ name: 'NotTarget', target: null }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['HasPeople']);
    // BenchOnly + Nobody + AllLeft. NotTarget was never a target, so it is not
    // "skipped" — it was never a candidate.
    expect(skippedCount).toBe(3);
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

  /**
   * CAR-259 inverts the assertion this test used to make. A company nobody works
   * at anymore has no job to email anyone about, so it stops generating a screen
   * in the walkthrough. Measured before the change: 53 of Dawson's 182 queued
   * companies had zero current employees, Qualtrics leading with 20 contacts and
   * not one still there.
   */
  it('skips a company whose entire roster has left, however many former employees', () => {
    const { queue, skippedCount } = buildOutreachQueue(
      [company({ name: 'FormerOnly', current_count: 0, former_count: 20 })],
      TODAY,
    );
    expect(queue).toEqual([]);
    // Counted as skipped, not silently dropped: the /outreach footer and the
    // MCP summary both report it so the company does not just vanish.
    expect(skippedCount).toBe(1);
  });

  it('keeps a company with current employees even when formers outnumber them', () => {
    const { queue } = buildOutreachQueue(
      [company({ name: 'Mixed', current_count: 1, former_count: 40 })],
      TODAY,
    );
    expect(queue.map((c) => c.name)).toEqual(['Mixed']);
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
