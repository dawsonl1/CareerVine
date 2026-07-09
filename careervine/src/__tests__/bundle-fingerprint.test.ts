import { describe, it, expect } from 'vitest';
import {
  computeContactFingerprint,
  postApplyFingerprint,
  isContactTouched,
  type ContactFingerprintInput,
  type ContactStateRow,
  type HardSignals,
} from '@/lib/bundle-sync';

function snapshot(overrides: Partial<ContactFingerprintInput> = {}): ContactFingerprintInput {
  return {
    name: 'Jane Analyst',
    headline: 'IB Analyst',
    notes: 'Imported from data bundle "IB Banks" on 7/9/2026',
    persona: null,
    network_status: 'prospect',
    stage_override: null,
    manual_employment_keys: [],
    manual_emails: [],
    tags: ['GS'],
    ...overrides,
  };
}

function state(overrides: Partial<ContactStateRow> = {}): ContactStateRow {
  return {
    contact_id: 42,
    applied_fingerprint: computeContactFingerprint(snapshot()),
    user_touched: false,
    apply_started_at: null,
    ...overrides,
  };
}

const NO_SIGNALS: HardSignals = { interactions: 0, meetings: 0, followUps: 0 };

describe('computeContactFingerprint', () => {
  it('is stable across array ordering', () => {
    const a = computeContactFingerprint(snapshot({ tags: ['b', 'a'], manual_emails: ['X@y.com', 'a@b.com'] }));
    const b = computeContactFingerprint(snapshot({ tags: ['a', 'b'], manual_emails: ['a@b.com', 'x@y.com'] }));
    expect(a).toBe(b);
  });

  it('changes when any user-editable field changes', () => {
    const base = computeContactFingerprint(snapshot());
    expect(computeContactFingerprint(snapshot({ notes: 'my own note' }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ name: 'Renamed' }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ network_status: 'active' }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ stage_override: 'responded' }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ manual_emails: ['new@x.com'] }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ manual_employment_keys: ['10|vp|jan 2026'] }))).not.toBe(base);
    expect(computeContactFingerprint(snapshot({ tags: ['GS', 'warm'] }))).not.toBe(base);
  });
});

describe('postApplyFingerprint', () => {
  it('is unchanged when the patch only touches non-fingerprint fields', () => {
    const pre = snapshot();
    const fp = postApplyFingerprint(pre, { last_scraped_at: '2026-07-09', linkedin_url: 'x', import_source: 'y' }, ['GS']);
    expect(fp).toBe(computeContactFingerprint(pre));
  });

  it('reflects a headline fill and additive tags exactly as the merge applied them', () => {
    const pre = snapshot({ headline: null, tags: ['GS'] });
    const fp = postApplyFingerprint(pre, { headline: 'IB Analyst' }, ['GS', 'NYC']);
    expect(fp).toBe(computeContactFingerprint(snapshot({ headline: 'IB Analyst', tags: ['GS', 'NYC'] })));
  });

  it('never double-counts tags the contact already has', () => {
    const pre = snapshot({ tags: ['GS', 'NYC'] });
    expect(postApplyFingerprint(pre, {}, ['NYC'])).toBe(computeContactFingerprint(pre));
  });
});

describe('isContactTouched', () => {
  const currentFp = computeContactFingerprint(snapshot());

  it('is untouched with matching fingerprint, no flag, no signals', () => {
    expect(isContactTouched(state(), NO_SIGNALS, currentFp)).toBe(false);
  });

  it('sticky user_touched always wins', () => {
    expect(isContactTouched(state({ user_touched: true }), NO_SIGNALS, currentFp)).toBe(true);
  });

  it('each hard signal independently marks touched', () => {
    expect(isContactTouched(state(), { ...NO_SIGNALS, interactions: 1 }, currentFp)).toBe(true);
    expect(isContactTouched(state(), { ...NO_SIGNALS, meetings: 1 }, currentFp)).toBe(true);
    expect(isContactTouched(state(), { ...NO_SIGNALS, followUps: 1 }, currentFp)).toBe(true);
  });

  it('fingerprint drift marks touched', () => {
    const drifted = computeContactFingerprint(snapshot({ notes: 'user edited this' }));
    expect(isContactTouched(state(), NO_SIGNALS, drifted)).toBe(true);
  });

  it('missing state or missing baseline is conservatively touched (never delete without history)', () => {
    expect(isContactTouched(null, NO_SIGNALS, currentFp)).toBe(true);
    expect(isContactTouched(state({ applied_fingerprint: null }), NO_SIGNALS, currentFp)).toBe(true);
  });
});
