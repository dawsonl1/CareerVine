import { describe, it, expect } from 'vitest';
import {
  canonicalizeLinkedinUrl,
  extractPublicIdentifier,
  extractCompanyUniversalName,
  isInternalLinkedinId,
} from '@/lib/linkedin-url';

describe('canonicalizeLinkedinUrl', () => {
  it('collapses slash/www/case/query variants to one canonical form', () => {
    const variants = [
      'https://www.linkedin.com/in/jane-doe',
      'https://www.linkedin.com/in/jane-doe/',
      'https://linkedin.com/in/jane-doe',
      'http://www.linkedin.com/in/Jane-Doe',
      'https://WWW.LINKEDIN.COM/in/jane-doe?utm_source=share',
      'www.linkedin.com/in/jane-doe/',
      'linkedin.com/in/jane-doe#section',
    ];
    for (const v of variants) {
      expect(canonicalizeLinkedinUrl(v)).toBe('https://www.linkedin.com/in/jane-doe');
    }
  });

  it('preserves case for internal-id (non-vanity) URLs', () => {
    expect(canonicalizeLinkedinUrl('https://www.linkedin.com/in/ACoAAABeT88BwbQS9opxl3myB4uSymqOSp4KD0o'))
      .toBe('https://www.linkedin.com/in/ACoAAABeT88BwbQS9opxl3myB4uSymqOSp4KD0o');
  });

  it('handles regional subdomains', () => {
    expect(canonicalizeLinkedinUrl('https://uk.linkedin.com/in/jane-doe'))
      .toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('returns null for non-LinkedIn and non-profile URLs', () => {
    expect(canonicalizeLinkedinUrl('https://example.com/in/jane-doe')).toBeNull();
    expect(canonicalizeLinkedinUrl('https://www.linkedin.com/company/google/')).toBeNull();
    expect(canonicalizeLinkedinUrl('https://notlinkedin.com/in/jane')).toBeNull();
    expect(canonicalizeLinkedinUrl('evil-linkedin.com.attacker.io/in/jane')).toBeNull();
    expect(canonicalizeLinkedinUrl('')).toBeNull();
    expect(canonicalizeLinkedinUrl(null)).toBeNull();
    expect(canonicalizeLinkedinUrl(undefined)).toBeNull();
  });

  it('decodes percent-encoded slugs', () => {
    expect(canonicalizeLinkedinUrl('https://www.linkedin.com/in/jos%C3%A9-garcia'))
      .toBe('https://www.linkedin.com/in/josé-garcia');
  });
});

describe('isInternalLinkedinId', () => {
  it('detects ACoAA / ACwAA internal ids', () => {
    expect(isInternalLinkedinId('ACoAAABeT88BwbQS9opxl3myB4uSymqOSp4KD0o')).toBe(true);
    expect(isInternalLinkedinId('ACwAAB1234')).toBe(true);
    expect(isInternalLinkedinId('jane-doe')).toBe(false);
    expect(isInternalLinkedinId('acoaa-lowercase-vanity')).toBe(false);
  });
});

describe('extractPublicIdentifier', () => {
  it('returns the slug for vanity URLs', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/Jane-Doe/')).toBe('jane-doe');
  });

  it('returns null for internal-id URLs (not a stable dedupe key)', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/ACoAAABeT88Bw')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(extractPublicIdentifier('not a url')).toBeNull();
  });
});

describe('extractCompanyUniversalName', () => {
  it('extracts the company slug', () => {
    expect(extractCompanyUniversalName('https://www.linkedin.com/company/google/')).toBe('google');
    expect(extractCompanyUniversalName('https://www.linkedin.com/company/Awardco/')).toBe('awardco');
  });

  it('returns null for numeric-only (internal id) company slugs', () => {
    expect(extractCompanyUniversalName('https://www.linkedin.com/company/15095601/')).toBeNull();
  });

  it('returns null for missing or non-company URLs', () => {
    expect(extractCompanyUniversalName(null)).toBeNull();
    expect(extractCompanyUniversalName('https://www.linkedin.com/in/jane-doe')).toBeNull();
  });
});
