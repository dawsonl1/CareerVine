import { describe, it, expect } from 'vitest';
import {
  normalizeLocation,
  normalizeParsedLocation,
  locationMatchKey,
  parseManualLocation,
} from '@/lib/location-normalizer';

describe('normalizeLocation — city grain (can establish offices)', () => {
  it('parses "City, State, Country" (the actor experience format)', () => {
    const r = normalizeLocation('Seattle, Washington, United States');
    expect(r).toMatchObject({
      city: 'Seattle', state: 'Washington', country: 'United States',
      granularity: 'city', canEstablishOffice: true, isRemote: false,
    });
  });

  it('parses "City, ST" abbreviations', () => {
    const r = normalizeLocation('San Diego, CA');
    expect(r).toMatchObject({ city: 'San Diego', state: 'California', country: 'United States', granularity: 'city' });
  });

  it('collapses metro-area strings: "Greater San Diego Area"', () => {
    const r = normalizeLocation('Greater San Diego Area');
    expect(r).toMatchObject({ city: 'San Diego', state: 'California', granularity: 'city', canEstablishOffice: true });
  });

  it('collapses "Greater Seattle Area"', () => {
    expect(normalizeLocation('Greater Seattle Area')).toMatchObject({ city: 'Seattle', state: 'Washington' });
  });

  it('collapses "San Francisco Bay Area"', () => {
    expect(normalizeLocation('San Francisco Bay Area')).toMatchObject({ city: 'San Francisco', state: 'California', granularity: 'city' });
  });

  it('collapses suburbs to their metro: "La Jolla, CA" → San Diego', () => {
    expect(normalizeLocation('La Jolla, CA')).toMatchObject({ city: 'San Diego', state: 'California' });
  });

  it('collapses boroughs: "Brooklyn, NY" → New York', () => {
    expect(normalizeLocation('Brooklyn, NY')).toMatchObject({ city: 'New York', state: 'New York' });
  });

  it('keeps distinct office cities distinct (no over-collapsing)', () => {
    expect(normalizeLocation('Mountain View, CA')).toMatchObject({ city: 'Mountain View', state: 'California' });
    expect(normalizeLocation('Bellevue, WA')).toMatchObject({ city: 'Bellevue', state: 'Washington' });
    expect(normalizeLocation('Sunnyvale, California, United States')).toMatchObject({ city: 'Sunnyvale' });
  });

  it('handles non-US cities', () => {
    expect(normalizeLocation('London, England, United Kingdom')).toMatchObject({
      city: 'London', country: 'United Kingdom', granularity: 'city',
    });
    expect(normalizeLocation('Toronto, Canada')).toMatchObject({ city: 'Toronto', country: 'Canada' });
  });

  it('handles "New York City Metropolitan Area"', () => {
    expect(normalizeLocation('New York City Metropolitan Area')).toMatchObject({ city: 'New York', state: 'New York' });
  });

  it('parses metro strings for unknown-but-city-state cores: "Greater Boise, ID Area" style recursion', () => {
    expect(normalizeLocation('Greater Boise, ID Area')).toMatchObject({ city: 'Boise', state: 'Idaho', granularity: 'city' });
  });
});

describe('normalizeLocation — coarse grains (cannot establish offices)', () => {
  it('classifies bare countries as country grain', () => {
    const r = normalizeLocation('United States');
    expect(r).toMatchObject({ city: null, state: null, country: 'United States', granularity: 'country', canEstablishOffice: false });
  });

  it('classifies "State, United States" as state grain', () => {
    const r = normalizeLocation('California, United States');
    expect(r).toMatchObject({ city: null, state: 'California', granularity: 'state', canEstablishOffice: false });
  });

  it('classifies bare states as state grain', () => {
    expect(normalizeLocation('Utah')).toMatchObject({ state: 'Utah', granularity: 'state', canEstablishOffice: false });
  });

  it('classifies vague regions as region grain', () => {
    expect(normalizeLocation('EMEA')).toMatchObject({ granularity: 'region', canEstablishOffice: false });
    expect(normalizeLocation('Asia Pacific')).toMatchObject({ granularity: 'region' });
  });

  it('returns unknown for garbage and empty input', () => {
    expect(normalizeLocation('')).toMatchObject({ granularity: 'unknown', canEstablishOffice: false });
    expect(normalizeLocation(null)).toMatchObject({ granularity: 'unknown' });
    expect(normalizeLocation('Metaverse HQ')).toMatchObject({ granularity: 'unknown', canEstablishOffice: false });
  });
});

describe('normalizeLocation — remote markers', () => {
  it('strips "(Remote)" and sets isRemote', () => {
    const r = normalizeLocation('San Diego, CA (Remote)');
    expect(r).toMatchObject({ city: 'San Diego', isRemote: true, granularity: 'city' });
  });

  it('detects bare "Remote"', () => {
    const r = normalizeLocation('Remote');
    expect(r).toMatchObject({ isRemote: true, granularity: 'unknown', canEstablishOffice: false });
  });

  it('detects "United States (Remote)"', () => {
    expect(normalizeLocation('United States (Remote)')).toMatchObject({ isRemote: true, granularity: 'country' });
  });
});

describe('normalizeParsedLocation', () => {
  it('normalizes the actor structured parse and applies alias collapsing', () => {
    expect(normalizeParsedLocation({ city: 'Seattle', state: 'Washington', country: 'United States' }))
      .toMatchObject({ city: 'Seattle', state: 'Washington', granularity: 'city', canEstablishOffice: true });
    expect(normalizeParsedLocation({ city: 'La Jolla', state: 'California', country: 'United States' }))
      .toMatchObject({ city: 'San Diego' });
  });

  it('state-only parse is state grain', () => {
    expect(normalizeParsedLocation({ city: null, state: 'Washington', country: 'United States' }))
      .toMatchObject({ granularity: 'state', canEstablishOffice: false });
  });

  it('empty parse is unknown', () => {
    expect(normalizeParsedLocation({})).toMatchObject({ granularity: 'unknown' });
  });
});

describe('locationMatchKey — rule-2 string-level matching', () => {
  it('matches equivalent strings normalized from different forms', () => {
    // A legacy "La Jolla" contact location must match a metro-grain
    // "San Diego" office — raw ID equality would silently miss this.
    const office = normalizeLocation('Greater San Diego Area');
    const legacyProfile = normalizeParsedLocation({ city: 'La Jolla', state: 'CA', country: 'United States' });
    expect(locationMatchKey(office)).toBe(locationMatchKey(legacyProfile));
    expect(locationMatchKey(office)).not.toBeNull();
  });

  it('returns null for non-city grains (they can never match an office)', () => {
    expect(locationMatchKey(normalizeLocation('California, United States'))).toBeNull();
    expect(locationMatchKey(normalizeLocation('United States'))).toBeNull();
    expect(locationMatchKey(normalizeLocation('EMEA'))).toBeNull();
  });

  it('distinct cities produce distinct keys', () => {
    expect(locationMatchKey(normalizeLocation('San Francisco, CA')))
      .not.toBe(locationMatchKey(normalizeLocation('Mountain View, CA')));
  });
});

describe('parseManualLocation — manual work-experience location', () => {
  it('normalizes "City, ST" to canonical parts + a compact display (US country omitted)', () => {
    expect(parseManualLocation('San Francisco, CA')).toEqual({
      isPlace: true, city: 'San Francisco', state: 'California', country: 'United States',
      display: 'San Francisco, California',
    });
  });

  it('is idempotent for an already-canonical "City, State"', () => {
    expect(parseManualLocation('San Francisco, California')).toMatchObject({
      isPlace: true, city: 'San Francisco', state: 'California', display: 'San Francisco, California',
    });
  });

  it('heals a lowercase / abbreviated state', () => {
    expect(parseManualLocation('new york, ny')).toMatchObject({
      isPlace: true, city: 'New York', state: 'New York', display: 'New York, New York',
    });
  });

  it('collapses a metro string via the shared normalizer', () => {
    expect(parseManualLocation('Greater Seattle Area')).toMatchObject({
      isPlace: true, city: 'Seattle', state: 'Washington', display: 'Seattle, Washington',
    });
  });

  it('keeps a non-US country in the display', () => {
    expect(parseManualLocation('London, UK')).toMatchObject({
      isPlace: true, city: 'London', state: null, country: 'United Kingdom',
      display: 'London, United Kingdom',
    });
  });

  it('keeps raw text (no place) for country-only, vague, or unparseable input', () => {
    expect(parseManualLocation('USA')).toMatchObject({ isPlace: false, display: 'USA' });
    expect(parseManualLocation('EMEA')).toMatchObject({ isPlace: false, display: 'EMEA' });
    expect(parseManualLocation('Remote')).toMatchObject({ isPlace: false, display: 'Remote' });
  });

  it('returns a null display for empty input', () => {
    expect(parseManualLocation('')).toMatchObject({ isPlace: false, display: null });
    expect(parseManualLocation('   ')).toMatchObject({ isPlace: false, display: null });
    expect(parseManualLocation(null)).toMatchObject({ isPlace: false, display: null });
  });
});
