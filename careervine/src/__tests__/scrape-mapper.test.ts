import { describe, it, expect, vi } from 'vitest';
import {
  mapPeopleRecord,
  pickRichestProfile,
  formatActorDate,
  ScrapeMappingError,
  type PeopleRecord,
} from '@/lib/scrape-mapper';

/** Minimal valid pipeline record, overridable per test. */
function makeRecord(overrides: Partial<PeopleRecord> = {}): PeopleRecord {
  return {
    schema_version: '1',
    identity: {
      name: 'Jane Doe',
      linkedin_url: 'https://www.linkedin.com/in/Jane-Doe/',
      company: 'Google',
      title: 'Product Manager',
      location: 'Greater Seattle Area',
      school: 'BYU',
      tenure: '2 yrs',
      ...overrides.identity,
    },
    pipeline: {
      found_by_searches: 'mini_a',
      persona: 'alum_product',
      priority_rank: '2',
      adjacency_score: '71',
      review_verdict: 'KEEP',
      review_reason: 'BYU alum PM at Google',
      selected_contact: 'SELECTED',
      selection_reason: 'top persona at company',
      review_sheet: '../reviews/2026-07_tranche1/scoring.xlsx',
      ...overrides.pipeline,
    },
    crm: {
      email: 'jane@google.com',
      email_source: 'scraped',
      stage: 'not_contacted',
      tags: ['alum_product'],
      history_highlights: 'PM on Search',
      ...overrides.crm,
    },
    raw_profiles: overrides.raw_profiles ?? [
      {
        source: 'shakedown/mini_a',
        data: {
          linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
          publicIdentifier: 'jane-doe',
          headline: 'PM at Google',
          photo: 'https://media.licdn.com/dms/image/abc.jpg',
          location: {
            linkedinText: 'Greater Seattle Area',
            parsed: { city: 'Seattle', state: 'Washington', country: 'United States' },
          },
          emails: [{ email: 'jane@google.com' }],
          experience: [
            {
              position: 'Product Manager',
              location: null,
              employmentType: 'Full-time',
              workplaceType: null,
              companyName: 'Google',
              companyLinkedinUrl: 'https://www.linkedin.com/company/google/',
              companyId: '1441',
              startDate: { month: 'Mar', year: 2021, text: 'Mar 2021' },
              endDate: { text: 'Present' },
            },
            {
              position: 'APM',
              location: 'Seattle, Washington, United States',
              employmentType: 'Full-time',
              workplaceType: 'On-site',
              companyName: 'Amazon',
              companyLinkedinUrl: 'https://www.linkedin.com/company/amazon/',
              companyId: '1586',
              startDate: { year: 2019, text: '2019' },
              endDate: { year: 2021, text: '2021' },
            },
          ],
          education: [
            {
              schoolName: 'Brigham Young University',
              degree: 'BS',
              fieldOfStudy: 'Information Systems',
              startDate: { year: 2015, text: '2015' },
              endDate: { year: 2019, text: '2019' },
            },
          ],
        },
      },
    ],
    history: overrides.history ?? [{ date: '2026-07-07', source: 'scoring.xlsx' }],
  };
}

describe('mapPeopleRecord — person core', () => {
  it('maps identity/pipeline/crm fields', () => {
    const p = mapPeopleRecord(makeRecord(), { batch: '2026-07_tranche1' });
    expect(p.name).toBe('Jane Doe');
    expect(p.linkedin_url).toBe('https://www.linkedin.com/in/jane-doe');
    expect(p.public_identifier).toBe('jane-doe');
    expect(p.non_vanity_url).toBe(false);
    expect(p.headline).toBe('PM at Google');
    expect(p.persona).toBe('alum_product');
    expect(p.review_note).toBe('BYU alum PM at Google');
    expect(p.verified_school).toBe('BYU');
    expect(p.import_source).toBe('apify:mini_a:2026-07_tranche1');
    expect(p.import_meta.adjacency_score).toBe(71);
    expect(p.import_meta.priority_rank).toBe(2);
    expect(p.import_meta.history).toHaveLength(1);
    expect(p.tags).toEqual(['alum_product']);
    expect(p.history_highlights).toBe('PM on Search');
    expect(p.photo_url).toBe('https://media.licdn.com/dms/image/abc.jpg');
    expect(p.profile_location).toEqual({ city: 'Seattle', state: 'Washington', country: 'United States' });
  });

  it('SELECTED → prospect, BENCH → bench', () => {
    expect(mapPeopleRecord(makeRecord()).network_status).toBe('prospect');
    expect(mapPeopleRecord(makeRecord({ pipeline: { selected_contact: 'BENCH' } })).network_status).toBe('bench');
  });

  it('maps crm.network_scope; missing defaults to target_company (B/C are company-scoped)', () => {
    expect(mapPeopleRecord(makeRecord({ crm: { network_scope: 'broad_network' } })).network_scope).toBe('broad_network');
    expect(mapPeopleRecord(makeRecord({ crm: { network_scope: 'target_company' } })).network_scope).toBe('target_company');
    // pre-column records have no network_scope at all
    expect(mapPeopleRecord(makeRecord()).network_scope).toBe('target_company');
  });

  it('unknown network_scope values default to target_company with a warning', () => {
    const p = mapPeopleRecord(makeRecord({ crm: { network_scope: 'galaxy_wide' } }));
    expect(p.network_scope).toBe('target_company');
    expect(p.warnings.some((w) => w.startsWith('unknown_network_scope:'))).toBe(true);
  });

  it('rejects wrong schema_version', () => {
    expect(() => mapPeopleRecord({ ...makeRecord(), schema_version: '2' })).toThrow(ScrapeMappingError);
  });

  it('rejects a record with no usable linkedin_url', () => {
    expect(() => mapPeopleRecord(makeRecord({ identity: { name: 'X', linkedin_url: 'garbage' } as PeopleRecord['identity'] })))
      .toThrow(ScrapeMappingError);
  });

  it('flags internal-id (non-vanity) URLs instead of rejecting', () => {
    const rec = makeRecord({
      identity: { name: 'Mystery Recruiter', linkedin_url: 'https://www.linkedin.com/in/ACwAAB12345' } as PeopleRecord['identity'],
      raw_profiles: [{ source: 's', data: { experience: [], education: [] } }],
    });
    const p = mapPeopleRecord(rec);
    expect(p.non_vanity_url).toBe(true);
    expect(p.warnings).toContain('non_vanity_url');
    expect(p.linkedin_url).toBe('https://www.linkedin.com/in/ACwAAB12345');
    expect(p.public_identifier).toBeNull();
  });

  it('reports unknown persona values instead of importing them', () => {
    const p = mapPeopleRecord(makeRecord({ pipeline: { persona: 'ceo_of_everything' } }));
    expect(p.persona).toBeNull();
    expect(p.warnings.some((w) => w.startsWith('unknown_persona:'))).toBe(true);
  });
});

describe('mapPeopleRecord — emails', () => {
  it('maps crm.email with hyphenated source → underscored', () => {
    const p = mapPeopleRecord(makeRecord({ crm: { email: 'j@x.com', email_source: 'pattern-guessed' } }));
    expect(p.email).toEqual({ address: 'j@x.com', source: 'pattern_guessed' });
  });

  it('empty email_source with an email defaults to scraped', () => {
    const p = mapPeopleRecord(makeRecord({ crm: { email: 'j@x.com', email_source: '' } }));
    expect(p.email).toEqual({ address: 'j@x.com', source: 'scraped' });
  });

  it('no crm.email falls back to raw emails[] — object entries', () => {
    const rec = makeRecord({ crm: { email: '', email_source: '' } });
    const p = mapPeopleRecord(rec);
    expect(p.email).toEqual({ address: 'jane@google.com', source: 'scraped' });
  });

  it('handles raw emails[] as plain strings', () => {
    const rec = makeRecord({ crm: { email: '', email_source: '' } });
    rec.raw_profiles![0].data!.emails = ['STRING@EXAMPLE.COM'];
    const p = mapPeopleRecord(rec);
    expect(p.email).toEqual({ address: 'string@example.com', source: 'scraped' });
  });

  it('no email anywhere → null', () => {
    const rec = makeRecord({ crm: { email: '', email_source: '' } });
    rec.raw_profiles![0].data!.emails = [];
    expect(mapPeopleRecord(rec).email).toBeNull();
  });
});

describe('mapPeopleRecord — employment', () => {
  it('builds employment from raw companyId, never identity.company (DeepMind case)', () => {
    const rec = makeRecord({ identity: { name: 'Jane Doe', linkedin_url: 'https://linkedin.com/in/jane-doe', company: 'Google' } as PeopleRecord['identity'] });
    rec.raw_profiles![0].data!.experience = [{
      position: 'Research PM',
      companyName: 'Google DeepMind',
      companyLinkedinUrl: 'https://www.linkedin.com/company/googledeepmind/',
      companyId: '208owner4',
      startDate: { month: 'Jan', year: 2023, text: 'Jan 2023' },
      endDate: { text: 'Present' },
    }];
    const p = mapPeopleRecord(rec);
    expect(p.employment[0].company_name).toBe('Google DeepMind');
    expect(p.employment[0].linkedin_company_id).toBe('208owner4');
    expect(p.employment[0].company_universal_name).toBe('googledeepmind');
  });

  it('"Present" end date → is_current with end_month Present', () => {
    const p = mapPeopleRecord(makeRecord());
    expect(p.employment[0]).toMatchObject({ is_current: true, end_month: 'Present', start_month: 'Mar 2021' });
    expect(p.employment[1]).toMatchObject({ is_current: false, end_month: '2021', start_month: '2019' });
  });

  it('missing endDate means current (LinkedIn semantics)', () => {
    const rec = makeRecord();
    rec.raw_profiles![0].data!.experience = [
      { position: 'X', companyName: 'Acme', companyId: '9', startDate: { year: 2024, text: '2024' } },
      { position: 'Y', companyName: 'Acme', companyId: '9', startDate: { year: 2023, text: '2023' }, endDate: {} },
    ];
    const p = mapPeopleRecord(rec);
    expect(p.employment[0].is_current).toBe(true);
    expect(p.employment[1].is_current).toBe(true);
  });

  it('maps workplaceType and tolerates missing values', () => {
    const p = mapPeopleRecord(makeRecord());
    expect(p.employment[0].workplace_type).toBeNull();
    expect(p.employment[1].workplace_type).toBe('on_site');
  });

  it('keeps per-role location as location_raw', () => {
    const p = mapPeopleRecord(makeRecord());
    expect(p.employment[0].location_raw).toBeNull();
    expect(p.employment[1].location_raw).toBe('Seattle, Washington, United States');
  });

  it('skips experience entries with no company at all, with a warning', () => {
    const rec = makeRecord();
    rec.raw_profiles![0].data!.experience = [
      { position: 'Freelancer', companyName: '', companyId: null },
    ];
    const p = mapPeopleRecord(rec);
    expect(p.employment).toHaveLength(0);
    expect(p.warnings.some((w) => w.startsWith('experience_without_company:'))).toBe(true);
    expect(p.warnings).toContain('no_employment_rows');
  });

  it('imports a person with no raw profile as person-only (empty-company shakedown case)', () => {
    const rec = makeRecord({ raw_profiles: [] });
    const p = mapPeopleRecord(rec);
    expect(p.employment).toHaveLength(0);
    expect(p.education).toHaveLength(0);
    expect(p.name).toBe('Jane Doe');
  });
});

describe('mapPeopleRecord — education', () => {
  it('maps school/degree/field/years', () => {
    const p = mapPeopleRecord(makeRecord());
    expect(p.education[0]).toEqual({
      school_name: 'Brigham Young University',
      degree: 'BS',
      field_of_study: 'Information Systems',
      start_year: 2015,
      end_year: 2019,
    });
  });

  it('tolerates null/empty education dates', () => {
    const rec = makeRecord();
    rec.raw_profiles![0].data!.education = [
      { schoolName: 'BYU Marriott School of Business', degree: 'MBA', fieldOfStudy: 'Finance', startDate: null, endDate: {} },
    ];
    const p = mapPeopleRecord(rec);
    expect(p.education[0]).toMatchObject({ school_name: 'BYU Marriott School of Business', start_year: null, end_year: null });
  });
});

describe('pickRichestProfile — multi-raw_profiles merge', () => {
  it('picks the profile with the most experience entries', () => {
    const rich = { experience: [{}, {}, {}] } as never;
    const poor = { experience: [{}] } as never;
    expect(pickRichestProfile([{ data: poor }, { data: rich }])).toBe(rich);
    expect(pickRichestProfile([{ data: rich }, { data: poor }])).toBe(rich);
  });

  it('ties go to the later (newer) entry', () => {
    const a = { experience: [{}], headline: 'old' } as never;
    const b = { experience: [{}], headline: 'new' } as never;
    expect(pickRichestProfile([{ data: a }, { data: b }])).toBe(b);
  });

  it('handles empty and missing data', () => {
    expect(pickRichestProfile([])).toBeNull();
    expect(pickRichestProfile(null)).toBeNull();
    expect(pickRichestProfile([{ data: null }])).toBeNull();
  });
});

describe('formatActorDate', () => {
  it('month+year → "Mon YYYY"', () => {
    expect(formatActorDate({ month: 'Mar', year: 2021, text: 'Mar 2021' })).toBe('Mar 2021');
  });
  it('year only → "YYYY"', () => {
    expect(formatActorDate({ year: 2020, text: '2020' })).toBe('2020');
  });
  it('text-only non-Present passes through; Present/null → null', () => {
    expect(formatActorDate({ text: 'Q3 2019' })).toBe('Q3 2019');
    expect(formatActorDate({ text: 'Present' })).toBeNull();
    expect(formatActorDate(null)).toBeNull();
    expect(formatActorDate({})).toBeNull();
  });
});

describe('mapPeopleRecord — photo URL allowlist (CAR-35)', () => {
  const BASE = 'https://assets.careervine.app';

  function recordWithPhoto(photo: string | null) {
    const record = makeRecord();
    record.raw_profiles![0].data!.photo = photo;
    return record;
  }

  it('passes through already-mirrored R2 bundle photos', () => {
    vi.stubEnv('R2_PUBLIC_BASE_URL', BASE);
    try {
      const url = `${BASE}/careervine/bundle-photos/abcdef0123456789.webp`;
      expect(mapPeopleRecord(recordWithPhoto(url)).photo_url).toBe(url);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still rejects arbitrary external photo hosts', () => {
    expect(mapPeopleRecord(recordWithPhoto('https://evil.example.com/x.jpg')).photo_url).toBeNull();
    expect(mapPeopleRecord(recordWithPhoto(null)).photo_url).toBeNull();
  });
});
