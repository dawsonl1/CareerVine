import { describe, it, expect } from 'vitest';
import {
  BUNDLE_PAYLOAD_SCHEMA_VERSION,
  bundleProspectPayloadV1Schema,
  bundleCompanyEntrySchema,
  parseBundleProspectPayload,
  payloadToMappedPerson,
  pickBestBundleEmail,
  type BundleProspectPayloadV1,
} from '@/lib/bundle-payload';

const CTX = { bundleId: 7, bundleSlug: 'ib-banks-nyc', bundleVersion: 3 };

function validPayload(overrides: Partial<BundleProspectPayloadV1> = {}): unknown {
  return {
    name: 'Jane Analyst',
    linkedin_url: 'https://www.linkedin.com/in/jane-analyst/',
    headline: 'IB Analyst at Goldman Sachs',
    photo_url: 'https://media.licdn.com/dms/image/abc',
    location: { city: 'New York', state: 'New York', country: 'United States' },
    emails: [{ email: 'jane@gs.com', source: 'scraped' }],
    experiences: [
      {
        title: 'Investment Banking Analyst',
        company: { name: 'Goldman Sachs', linkedin_company_id: '1382' },
        start_month: 'Jul 2025',
        is_current: true,
      },
    ],
    education: [{ school_name: 'BYU', degree: 'BS', field_of_study: 'Finance', start_year: 2021, end_year: 2025 }],
    tags: ['GS', 'NYC'],
    ...overrides,
  };
}

describe('bundleProspectPayloadV1Schema', () => {
  it('accepts a valid payload and canonicalizes the LinkedIn URL', () => {
    const parsed = bundleProspectPayloadV1Schema.parse(
      validPayload({ linkedin_url: 'https://linkedin.com/in/Jane-Analyst/?utm=x' as never }),
    );
    expect(parsed.linkedin_url).toBe('https://www.linkedin.com/in/jane-analyst');
  });

  it('rejects a payload with no usable LinkedIn URL', () => {
    const result = bundleProspectPayloadV1Schema.safeParse(validPayload({ linkedin_url: 'not-a-url' as never }));
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = bundleProspectPayloadV1Schema.safeParse(validPayload({ name: '' as never }));
    expect(result.success).toBe(false);
  });

  it('rejects an experience whose company has neither name nor linkedin_company_id', () => {
    const result = bundleProspectPayloadV1Schema.safeParse(
      validPayload({
        experiences: [
          { title: 'Analyst', company: { name: null }, is_current: true },
        ] as never,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects invalid email sources (manual is not a bundle source)', () => {
    const result = bundleProspectPayloadV1Schema.safeParse(
      validPayload({ emails: [{ email: 'a@b.com', source: 'manual' }] as never }),
    );
    expect(result.success).toBe(false);
  });

  it('lowercases email addresses', () => {
    const parsed = bundleProspectPayloadV1Schema.parse(
      validPayload({ emails: [{ email: 'Jane@GS.com', source: 'verified' }] as never }),
    );
    expect(parsed.emails[0].email).toBe('jane@gs.com');
  });

  it('defaults optional arrays to empty', () => {
    const parsed = bundleProspectPayloadV1Schema.parse({
      name: 'Minimal Person',
      linkedin_url: 'https://www.linkedin.com/in/minimal',
    });
    expect(parsed.emails).toEqual([]);
    expect(parsed.experiences).toEqual([]);
    expect(parsed.education).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });
});

describe('parseBundleProspectPayload', () => {
  it('parses a known version', () => {
    const result = parseBundleProspectPayload(validPayload(), BUNDLE_PAYLOAD_SCHEMA_VERSION);
    expect(result.ok).toBe(true);
  });

  it('skips-and-reports unknown schema versions instead of throwing', () => {
    const result = parseBundleProspectPayload(validPayload(), 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_payload_schema_version:2');
  });

  it('reports invalid payloads without throwing', () => {
    const result = parseBundleProspectPayload({ nonsense: true }, BUNDLE_PAYLOAD_SCHEMA_VERSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^invalid_payload:/);
  });
});

describe('payloadToMappedPerson', () => {
  const payload = bundleProspectPayloadV1Schema.parse(validPayload());

  it('stamps bundle provenance and prospect status', () => {
    const mapped = payloadToMappedPerson(payload, CTX);
    expect(mapped.import_source).toBe('bundle:ib-banks-nyc');
    expect(mapped.import_meta).toEqual({ bundle_id: 7, bundle_slug: 'ib-banks-nyc', bundle_version: 3 });
    expect(mapped.network_status).toBe('prospect');
    expect(mapped.network_scope).toBe('target_company');
    expect(mapped.persona).toBeNull();
  });

  it('derives public_identifier from the canonical URL when absent', () => {
    const mapped = payloadToMappedPerson(payload, CTX);
    expect(mapped.public_identifier).toBe('jane-analyst');
    expect(mapped.non_vanity_url).toBe(false);
  });

  it('maps experiences to MappedEmployment with Present for current roles', () => {
    const mapped = payloadToMappedPerson(payload, CTX);
    expect(mapped.employment).toHaveLength(1);
    expect(mapped.employment[0]).toMatchObject({
      title: 'Investment Banking Analyst',
      company_name: 'Goldman Sachs',
      linkedin_company_id: '1382',
      start_month: 'Jul 2025',
      end_month: 'Present',
      is_current: true,
    });
  });

  it('derives company universal_name from the company LinkedIn URL when not supplied', () => {
    const p = bundleProspectPayloadV1Schema.parse(
      validPayload({
        experiences: [
          {
            title: 'Analyst',
            company: { name: 'Goldman Sachs', linkedin_url: 'https://www.linkedin.com/company/goldman-sachs/' },
            is_current: true,
          },
        ] as never,
      }),
    );
    const mapped = payloadToMappedPerson(p, CTX);
    expect(mapped.employment[0].company_universal_name).toBe('goldman-sachs');
  });

  it('maps education and tags through unchanged', () => {
    const mapped = payloadToMappedPerson(payload, CTX);
    expect(mapped.education).toEqual([
      { school_name: 'BYU', degree: 'BS', field_of_study: 'Finance', start_year: 2021, end_year: 2025 },
    ]);
    expect(mapped.tags).toEqual(['GS', 'NYC']);
  });
});

describe('pickBestBundleEmail', () => {
  it('prefers verified over scraped over pattern_guessed', () => {
    expect(
      pickBestBundleEmail([
        { email: 'guess@x.com', source: 'pattern_guessed' },
        { email: 'verified@x.com', source: 'verified' },
        { email: 'scraped@x.com', source: 'scraped' },
      ]),
    ).toEqual({ address: 'verified@x.com', source: 'verified' });
  });

  it('returns null for an empty list', () => {
    expect(pickBestBundleEmail([])).toBeNull();
  });
});

describe('bundleCompanyEntrySchema', () => {
  it('accepts a company with offices', () => {
    const parsed = bundleCompanyEntrySchema.parse({
      name: 'Goldman Sachs',
      linkedin_company_id: '1382',
      offices: [{ city: 'New York', state: 'New York', country: 'United States' }],
    });
    expect(parsed.offices).toHaveLength(1);
  });

  it('rejects a company without a name', () => {
    expect(bundleCompanyEntrySchema.safeParse({ offices: [] }).success).toBe(false);
  });
});
