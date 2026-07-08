import { describe, it, expect } from 'vitest';
import {
  computeEmploymentMerge,
  computeEmailMerge,
  computeContactPatch,
  resolveNetworkStatus,
  employmentKey,
  type ExistingEmploymentRow,
  type IncomingEmploymentRow,
} from '@/lib/scrape-merge';
import type { MappedPerson } from '@/lib/scrape-mapper';

const NOW = '2026-07-07T00:00:00.000Z';

function existingRow(overrides: Partial<ExistingEmploymentRow> = {}): ExistingEmploymentRow {
  return {
    id: 1, company_id: 10, title: 'PM', start_month: 'Jan 2023', end_month: 'Present',
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: 'Full-time', source: 'scraped',
    ...overrides,
  };
}

function incomingRow(overrides: Partial<IncomingEmploymentRow> = {}): IncomingEmploymentRow {
  return {
    company_id: 10, title: 'PM', start_month: 'Jan 2023', end_month: 'Present',
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: 'Full-time',
    ...overrides,
  };
}

describe('computeEmploymentMerge', () => {
  it('matched scraped row gets field-level update + scraped_at refresh', () => {
    const plan = computeEmploymentMerge(
      [existingRow()],
      [incomingRow({ end_month: 'Jun 2026', is_current: false, workplace_type: 'hybrid' })],
      NOW,
    );
    expect(plan.inserts).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.updates).toEqual([{
      id: 1,
      fields: { scraped_at: NOW, end_month: 'Jun 2026', is_current: false, workplace_type: 'hybrid' },
    }]);
  });

  it('manual rows survive re-import untouched except scraped_at', () => {
    const plan = computeEmploymentMerge(
      [existingRow({ source: 'manual', title: 'PM' })],
      [incomingRow({ end_month: 'Dec 2025', is_current: false })],
      NOW,
    );
    expect(plan.updates).toEqual([{ id: 1, fields: { scraped_at: NOW } }]);
    expect(plan.deleteIds).toHaveLength(0);
  });

  it('manually-set locations win on scraped rows', () => {
    const plan = computeEmploymentMerge(
      [existingRow({ location_id: 5, location_source: 'manual' })],
      [incomingRow({ location_id: 9, location_source: 'experience', location_raw: 'Austin, TX' })],
      NOW,
    );
    const fields = plan.updates[0].fields;
    expect(fields.location_id).toBeUndefined();
    expect(fields.location_source).toBeUndefined();
    expect(fields.location_raw).toBeUndefined();
  });

  it('scraped locations follow the fresh scrape', () => {
    const plan = computeEmploymentMerge(
      [existingRow({ location_id: 5, location_source: 'profile_match' })],
      [incomingRow({ location_id: 9, location_source: 'experience', location_raw: 'Austin, TX' })],
      NOW,
    );
    expect(plan.updates[0].fields).toMatchObject({ location_id: 9, location_source: 'experience', location_raw: 'Austin, TX' });
  });

  it('deletes scraped rows absent from the payload, retains manual ones', () => {
    const plan = computeEmploymentMerge(
      [
        existingRow({ id: 1, title: 'Old scraped role', start_month: 'Jan 2019' }),
        existingRow({ id: 2, title: 'Manual role', start_month: 'Feb 2020', source: 'manual' }),
      ],
      [incomingRow({ title: 'New role', start_month: 'Mar 2024' })],
      NOW,
    );
    expect(plan.deleteIds).toEqual([1]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({ title: 'New role', source: 'scraped', scraped_at: NOW });
  });

  it('keeps boomerang stints distinct (same company+title, different start)', () => {
    const plan = computeEmploymentMerge(
      [existingRow({ id: 1, start_month: 'Jan 2019', end_month: 'Dec 2020', is_current: false })],
      [
        incomingRow({ start_month: 'Jan 2019', end_month: 'Dec 2020', is_current: false }),
        incomingRow({ start_month: 'Mar 2024' }),
      ],
      NOW,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].start_month).toBe('Mar 2024');
    expect(plan.deleteIds).toHaveLength(0);
  });

  it('keeps concurrent roles distinct (multiple is_current)', () => {
    const incoming = [
      incomingRow({ title: 'PM', company_id: 10 }),
      incomingRow({ title: 'Advisor', company_id: 20, start_month: 'Jun 2024' }),
    ];
    const plan = computeEmploymentMerge([], incoming, NOW);
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts.every((r) => r.is_current)).toBe(true);
  });

  it('is order-independent: shuffled incoming produces the same plan', () => {
    const existing = [
      existingRow({ id: 1, title: 'A', start_month: 'Jan 2020' }),
      existingRow({ id: 2, title: 'B', start_month: 'Feb 2021' }),
      existingRow({ id: 3, title: 'C', start_month: 'Mar 2022', source: 'manual' }),
    ];
    const incoming = [
      incomingRow({ title: 'B', start_month: 'Feb 2021', end_month: 'May 2026', is_current: false }),
      incomingRow({ title: 'D', start_month: 'Apr 2023' }),
      incomingRow({ title: 'A', start_month: 'Jan 2020' }),
    ];
    const normalize = (plan: ReturnType<typeof computeEmploymentMerge>) => ({
      inserts: [...plan.inserts].sort((a, b) => employmentKey(a).localeCompare(employmentKey(b))),
      updates: [...plan.updates].sort((a, b) => a.id - b.id),
      deleteIds: [...plan.deleteIds].sort(),
    });
    const a = normalize(computeEmploymentMerge(existing, incoming, NOW));
    const b = normalize(computeEmploymentMerge(existing, [...incoming].reverse(), NOW));
    expect(a).toEqual(b);
    // Re-running the SAME payload against the post-merge state is a no-op:
    // matched rows only refresh scraped_at, nothing inserted or deleted.
    const reRun = computeEmploymentMerge(
      [
        existingRow({ id: 1, title: 'A', start_month: 'Jan 2020' }),
        existingRow({ id: 2, title: 'B', start_month: 'Feb 2021', end_month: 'May 2026', is_current: false }),
        existingRow({ id: 3, title: 'C', start_month: 'Mar 2022', source: 'manual' }),
        existingRow({ id: 4, title: 'D', start_month: 'Apr 2023' }),
      ],
      incoming,
      NOW,
    );
    expect(reRun.inserts).toHaveLength(0);
    expect(reRun.deleteIds).toHaveLength(0);
    expect(reRun.updates.every((u) => Object.keys(u.fields).length === 1 && 'scraped_at' in u.fields)).toBe(true);
  });

  it('dedupes duplicate incoming rows on the natural key', () => {
    const plan = computeEmploymentMerge([], [incomingRow(), incomingRow()], NOW);
    expect(plan.inserts).toHaveLength(1);
  });
});

describe('computeEmailMerge — monotonic source lifecycle', () => {
  const rows = (source: string) => [{ id: 1, email: 'j@x.com', is_primary: true, source }];

  it('upgrades pattern_guessed → scraped → verified', () => {
    expect(computeEmailMerge(rows('pattern_guessed'), { address: 'j@x.com', source: 'scraped' }).update)
      .toEqual({ id: 1, fields: { source: 'scraped' } });
    expect(computeEmailMerge(rows('scraped'), { address: 'j@x.com', source: 'verified' }).update)
      .toEqual({ id: 1, fields: { source: 'verified' } });
  });

  it('never downgrades', () => {
    expect(computeEmailMerge(rows('verified'), { address: 'j@x.com', source: 'scraped' }).update).toBeNull();
    expect(computeEmailMerge(rows('scraped'), { address: 'j@x.com', source: 'pattern_guessed' }).update).toBeNull();
  });

  it('never modifies manual rows', () => {
    expect(computeEmailMerge(rows('manual'), { address: 'j@x.com', source: 'verified' }).update).toBeNull();
  });

  it('inserts new addresses, primary only when none exists', () => {
    expect(computeEmailMerge([], { address: 'New@X.com', source: 'scraped' }).insert)
      .toEqual({ email: 'new@x.com', source: 'scraped', is_primary: true });
    expect(computeEmailMerge(rows('manual'), { address: 'other@x.com', source: 'scraped' }).insert)
      .toEqual({ email: 'other@x.com', source: 'scraped', is_primary: false });
  });

  it('no incoming email → no ops', () => {
    expect(computeEmailMerge(rows('manual'), null)).toEqual({ insert: null, update: null });
  });
});

describe('resolveNetworkStatus — re-import never demotes', () => {
  it('active is never touched', () => {
    expect(resolveNetworkStatus('active', 'bench')).toBe('active');
    expect(resolveNetworkStatus('active', 'prospect')).toBe('active');
  });
  it('prospect is never demoted to bench', () => {
    expect(resolveNetworkStatus('prospect', 'bench')).toBe('prospect');
  });
  it('bench may be promoted to prospect', () => {
    expect(resolveNetworkStatus('bench', 'prospect')).toBe('prospect');
    expect(resolveNetworkStatus('bench', 'bench')).toBe('bench');
  });
});

describe('computeContactPatch', () => {
  const mapped = {
    name: 'Jane Doe',
    headline: 'PM at Google',
    persona: 'alum_product',
    review_note: 'note',
    verified_school: 'BYU',
    import_source: 'apify:mini_a',
    import_meta: { adjacency_score: 71 },
    public_identifier: 'jane-doe',
    network_status: 'prospect',
  } as unknown as MappedPerson;

  const existing = { id: 1, name: 'Jane Doe', persona: null, network_status: 'bench', location_id: null, headline: null };

  it('fills persona when empty; reports (not applies) conflicts', () => {
    const fill = computeContactPatch(existing, mapped, NOW, null);
    expect(fill.patch.persona).toBe('alum_product');
    expect(fill.personaConflict).toBeNull();

    const conflict = computeContactPatch({ ...existing, persona: 'recruiter' }, mapped, NOW, null);
    expect(conflict.patch.persona).toBeUndefined();
    expect(conflict.personaConflict).toEqual({ existing: 'recruiter', incoming: 'alum_product' });
  });

  it('never overwrites a real name; refreshes placeholders', () => {
    expect(computeContactPatch({ ...existing, name: 'Custom Name' }, mapped, NOW, null).patch.name).toBeUndefined();
    expect(computeContactPatch({ ...existing, name: 'Unknown' }, mapped, NOW, null).patch.name).toBe('Jane Doe');
  });

  it('sets profile location only when the contact has none', () => {
    expect(computeContactPatch(existing, mapped, NOW, 42).patch.location_id).toBe(42);
    expect(computeContactPatch({ ...existing, location_id: 7 }, mapped, NOW, 42).patch.location_id).toBeUndefined();
  });

  it('applies network-status transitions through resolveNetworkStatus', () => {
    expect(computeContactPatch(existing, mapped, NOW, null).patch.network_status).toBe('prospect');
    expect(computeContactPatch({ ...existing, network_status: 'prospect' }, { ...mapped, network_status: 'bench' } as MappedPerson, NOW, null).patch.network_status).toBeUndefined();
  });

  it('always refreshes provenance and staleness', () => {
    const { patch } = computeContactPatch(existing, mapped, NOW, null);
    expect(patch.last_scraped_at).toBe(NOW);
    expect(patch.import_source).toBe('apify:mini_a');
    expect(patch.import_meta).toEqual({ adjacency_score: 71 });
  });

  it('refreshes the pipeline-owned network_scope on every import', () => {
    const scoped = { ...mapped, network_scope: 'broad_network' } as MappedPerson;
    expect(computeContactPatch(existing, scoped, NOW, null).patch.network_scope).toBe('broad_network');
  });
});
