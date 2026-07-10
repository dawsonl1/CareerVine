import { describe, it, expect } from 'vitest';
import {
  computeContactPatch,
  computeEmploymentMerge,
  type ExistingContactCore,
  type ExistingEmploymentRow,
  type IncomingEmploymentRow,
} from '@/lib/scrape-merge';
import type { MappedPerson } from '@/lib/scrape-mapper';

const NOW = '2026-07-08T00:00:00.000Z';

function mapped(overrides: Partial<MappedPerson> = {}): MappedPerson {
  return {
    name: 'Jane Analyst',
    linkedin_url: 'https://www.linkedin.com/in/jane-analyst',
    public_identifier: 'jane-analyst',
    non_vanity_url: false,
    headline: 'IB Analyst at Goldman Sachs',
    persona: null,
    review_note: null,
    verified_school: null,
    network_status: 'prospect',
    network_scope: 'target_company',
    import_source: 'bundle:ib-banks-nyc',
    import_meta: { bundle_id: 1, bundle_slug: 'ib-banks-nyc', bundle_version: 2 },
    tags: [],
    history_highlights: null,
    profile_location_raw: null,
    profile_location: null,
    photo_url: null,
    email: null,
    employment: [],
    education: [],
    warnings: [],
    ...overrides,
  };
}

function existingContact(overrides: Partial<ExistingContactCore> = {}): ExistingContactCore {
  return {
    id: 42,
    name: 'Jane Analyst',
    persona: null,
    network_status: 'prospect',
    location_id: null,
    headline: null,
    public_identifier: null,
    ...overrides,
  };
}

describe('computeContactPatch — bundle policy', () => {
  it('never overwrites an existing headline (user edits survive silent syncs)', () => {
    const { patch } = computeContactPatch(
      existingContact({ headline: 'My hand-written headline' }),
      mapped(),
      NOW,
      null,
      'bundle',
    );
    expect(patch).not.toHaveProperty('headline');
  });

  it('fills an empty headline', () => {
    const { patch } = computeContactPatch(existingContact(), mapped(), NOW, null, 'bundle');
    expect(patch.headline).toBe('IB Analyst at Goldman Sachs');
  });

  it('never touches provenance or network_scope on merge (create-only stamping)', () => {
    const { patch } = computeContactPatch(existingContact(), mapped(), NOW, null, 'bundle');
    expect(patch).not.toHaveProperty('import_source');
    expect(patch).not.toHaveProperty('import_meta');
    expect(patch).not.toHaveProperty('network_scope');
    expect(patch).not.toHaveProperty('review_note');
  });

  it('fills public_identifier only when the contact has none', () => {
    const filled = computeContactPatch(existingContact(), mapped(), NOW, null, 'bundle');
    expect(filled.patch.public_identifier).toBe('jane-analyst');

    const kept = computeContactPatch(
      existingContact({ public_identifier: 'existing-pid' }),
      mapped(),
      NOW,
      null,
      'bundle',
    );
    expect(kept.patch).not.toHaveProperty('public_identifier');
  });

  it('still refreshes last_scraped_at and never demotes network status', () => {
    const { patch } = computeContactPatch(
      existingContact({ network_status: 'active' }),
      mapped({ network_status: 'bench' }),
      NOW,
      null,
      'bundle',
    );
    expect(patch.last_scraped_at).toBe(NOW);
    expect(patch).not.toHaveProperty('network_status');
  });
});

describe('computeContactPatch — pipeline policy unchanged', () => {
  it('still refreshes headline and provenance wholesale', () => {
    const { patch } = computeContactPatch(
      existingContact({ headline: 'Old headline' }),
      mapped({ import_source: 'apify:mini_a:2026-07' }),
      NOW,
      null,
      'pipeline',
    );
    expect(patch.headline).toBe('IB Analyst at Goldman Sachs');
    expect(patch.import_source).toBe('apify:mini_a:2026-07');
    expect(patch).toHaveProperty('import_meta');
    expect(patch.network_scope).toBe('target_company');
  });

  it('defaults to pipeline when no policy is passed (backward compatibility)', () => {
    const { patch } = computeContactPatch(existingContact({ headline: 'Old' }), mapped(), NOW, null);
    expect(patch.headline).toBe('IB Analyst at Goldman Sachs');
  });
});

describe('computeEmploymentMerge — bundle policy', () => {
  const existingScraped: ExistingEmploymentRow = {
    id: 1, company_id: 10, title: 'Analyst', start_month: 'Jul 2024', end_month: 'Present',
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: null, source: 'scraped',
  };
  const otherIncoming: IncomingEmploymentRow = {
    company_id: 99, title: 'Associate', start_month: 'Jan 2026', end_month: 'Present',
    is_current: true, location_id: null, location_source: null, location_raw: null,
    workplace_type: null, employment_type: null,
  };

  it('never deletes scraped rows absent from the payload (additive across bundles)', () => {
    const plan = computeEmploymentMerge([existingScraped], [otherIncoming], NOW, 'bundle');
    expect(plan.deleteIds).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
  });

  it('pipeline policy still deletes scraped rows absent from the payload', () => {
    const plan = computeEmploymentMerge([existingScraped], [otherIncoming], NOW, 'pipeline');
    expect(plan.deleteIds).toEqual([1]);
  });

  it('bundle policy still field-updates matched scraped rows', () => {
    const matchedIncoming: IncomingEmploymentRow = {
      ...otherIncoming, company_id: 10, title: 'Analyst', start_month: 'Jul 2024',
      end_month: 'Jun 2026', is_current: false,
    };
    const plan = computeEmploymentMerge([existingScraped], [matchedIncoming], NOW, 'bundle');
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].fields.end_month).toBe('Jun 2026');
  });
});
