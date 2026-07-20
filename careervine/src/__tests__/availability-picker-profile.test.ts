import { describe, it, expect } from 'vitest';
import { profileToPickerState, isWorkingDaysProfile } from '@/components/availability-picker';

// gmail_connections.availability_standard / availability_priority are Json
// columns, so the picker reads them as `unknown` and narrows (CAR-158). These
// cover both live shapes plus the corrupt blobs the narrowing has to survive.

const DEFAULTS = {
  daysOfWeek: [1, 2, 3, 4, 5],
  windowStart: '09:00',
  windowEnd: '18:00',
  bufferBefore: 10,
  bufferAfter: 10,
};

const day = (d: number, overrides: Record<string, unknown> = {}) => ({
  day: d,
  enabled: true,
  startTime: '10:00',
  endTime: '16:00',
  bufferBefore: 5,
  bufferAfter: 15,
  ...overrides,
});

describe('isWorkingDaysProfile', () => {
  it('accepts a well-formed per-day profile', () => {
    expect(isWorkingDaysProfile({ workingDays: [day(0), day(1)] })).toBe(true);
  });

  it('accepts an empty workingDays array', () => {
    expect(isWorkingDaysProfile({ workingDays: [] })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isWorkingDaysProfile(null)).toBe(false);
    expect(isWorkingDaysProfile(undefined)).toBe(false);
    expect(isWorkingDaysProfile('workingDays')).toBe(false);
  });

  it('rejects a workingDays value that is not an array', () => {
    expect(isWorkingDaysProfile({ workingDays: { 0: day(0) } })).toBe(false);
  });

  it('rejects entries missing day or enabled', () => {
    expect(isWorkingDaysProfile({ workingDays: [{ enabled: true }] })).toBe(false);
    expect(isWorkingDaysProfile({ workingDays: [{ day: 0 }] })).toBe(false);
    expect(isWorkingDaysProfile({ workingDays: [day(0), null] })).toBe(false);
  });

  it('rejects a legacy flat profile', () => {
    expect(isWorkingDaysProfile({ days: [1, 2], windowStart: '08:00' })).toBe(false);
  });
});

describe('profileToPickerState — per-day profiles', () => {
  it('maps enabled days to 1-indexed day numbers and reads the first window', () => {
    const state = profileToPickerState({ workingDays: [day(0), day(2)] });
    expect(state).toEqual({
      daysOfWeek: [1, 3],
      windowStart: '10:00',
      windowEnd: '16:00',
      bufferBefore: 5,
      bufferAfter: 15,
    });
  });

  it('ignores disabled days', () => {
    const state = profileToPickerState({
      workingDays: [day(0, { enabled: false }), day(4)],
    });
    expect(state.daysOfWeek).toEqual([5]);
  });

  it('falls back to defaults when no day is enabled', () => {
    const state = profileToPickerState({
      workingDays: [day(0, { enabled: false }), day(1, { enabled: false })],
    });
    expect(state).toEqual(DEFAULTS);
  });

  it('defaults the fields an older row can omit', () => {
    const state = profileToPickerState({ workingDays: [{ day: 0, enabled: true }] });
    expect(state).toEqual({ ...DEFAULTS, daysOfWeek: [1] });
  });

  it('treats bufferBefore/bufferAfter of 0 as real values, not missing', () => {
    const state = profileToPickerState({
      workingDays: [day(0, { bufferBefore: 0, bufferAfter: 0 })],
    });
    expect(state.bufferBefore).toBe(0);
    expect(state.bufferAfter).toBe(0);
  });
});

describe('profileToPickerState — legacy flat profiles', () => {
  it('reads the legacy shape', () => {
    const state = profileToPickerState({
      days: [2, 4],
      windowStart: '08:30',
      windowEnd: '17:00',
      bufferBefore: 0,
      bufferAfter: 20,
    });
    expect(state).toEqual({
      daysOfWeek: [2, 4],
      windowStart: '08:30',
      windowEnd: '17:00',
      bufferBefore: 0,
      bufferAfter: 20,
    });
  });

  it('keeps default days when the legacy days array is empty', () => {
    const state = profileToPickerState({ days: [], windowStart: '07:00' });
    expect(state.daysOfWeek).toEqual(DEFAULTS.daysOfWeek);
    expect(state.windowStart).toBe('07:00');
  });

  it('drops non-numeric entries from the legacy days array', () => {
    const state = profileToPickerState({ days: [1, '3', null, 5] });
    expect(state.daysOfWeek).toEqual([1, 5]);
  });

  it('ignores legacy fields of the wrong type', () => {
    const state = profileToPickerState({
      days: [1],
      windowStart: 900,
      bufferBefore: '5',
    });
    expect(state.windowStart).toBe(DEFAULTS.windowStart);
    expect(state.bufferBefore).toBe(DEFAULTS.bufferBefore);
  });

  it('ignores a flat blob with no days key', () => {
    expect(profileToPickerState({ windowStart: '07:00' })).toEqual(DEFAULTS);
  });
});

describe('profileToPickerState — malformed blobs', () => {
  it('returns defaults for null/undefined', () => {
    expect(profileToPickerState(null)).toEqual(DEFAULTS);
    expect(profileToPickerState(undefined)).toEqual(DEFAULTS);
  });

  it('returns defaults for the empty object left by the CAR-130 Zod strip bug', () => {
    expect(profileToPickerState({})).toEqual(DEFAULTS);
  });

  it('returns defaults instead of throwing when workingDays is not an array', () => {
    // Previously this reached .filter() on a non-array and threw.
    expect(() => profileToPickerState({ workingDays: 'monday' })).not.toThrow();
    expect(profileToPickerState({ workingDays: 'monday' })).toEqual(DEFAULTS);
  });

  it('returns defaults instead of throwing when a day entry is malformed', () => {
    expect(profileToPickerState({ workingDays: [{ enabled: true }] })).toEqual(DEFAULTS);
  });

  it('returns defaults for primitives', () => {
    expect(profileToPickerState('nope')).toEqual(DEFAULTS);
    expect(profileToPickerState(42)).toEqual(DEFAULTS);
  });
});
