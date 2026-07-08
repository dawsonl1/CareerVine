import { describe, it, expect } from 'vitest';
import { deriveOutreachStage, stageRank, type StageSignals } from '@/lib/stage-derivation';

function signals(overrides: Partial<StageSignals> = {}): StageSignals {
  return {
    stageOverride: null,
    hasReferral: false,
    hasPastCall: false,
    hasUpcomingCall: false,
    hasReply: false,
    hasOutboundEmail: false,
    hasInteraction: false,
    hasBouncedEmail: false,
    ...overrides,
  };
}

describe('deriveOutreachStage', () => {
  it('no signals → not_contacted', () => {
    expect(deriveOutreachStage(signals())).toBe('not_contacted');
  });

  it('outbound email → contacted', () => {
    expect(deriveOutreachStage(signals({ hasOutboundEmail: true }))).toBe('contacted');
  });

  it('a logged interaction counts as contacted (email is not the only channel)', () => {
    expect(deriveOutreachStage(signals({ hasInteraction: true }))).toBe('contacted');
  });

  it('reply beats contacted', () => {
    expect(deriveOutreachStage(signals({ hasOutboundEmail: true, hasReply: true }))).toBe('replied');
  });

  it('upcoming call beats replied; past call beats scheduled; referral beats all', () => {
    expect(deriveOutreachStage(signals({ hasReply: true, hasUpcomingCall: true }))).toBe('call_scheduled');
    expect(deriveOutreachStage(signals({ hasUpcomingCall: true, hasPastCall: true }))).toBe('call_done');
    expect(deriveOutreachStage(signals({ hasPastCall: true, hasReferral: true }))).toBe('referral');
  });

  it('bounce surfaces distinctly when contacted with no reply', () => {
    expect(deriveOutreachStage(signals({ hasOutboundEmail: true, hasBouncedEmail: true }))).toBe('bounced');
  });

  it('a reply suppresses the bounce (they answered from another address)', () => {
    expect(deriveOutreachStage(signals({ hasOutboundEmail: true, hasBouncedEmail: true, hasReply: true }))).toBe('replied');
  });

  it('a bounce with no outreach at all stays not_contacted', () => {
    expect(deriveOutreachStage(signals({ hasBouncedEmail: true }))).toBe('not_contacted');
  });

  it('stage_override wins over everything', () => {
    expect(deriveOutreachStage(signals({ stageOverride: 'call_done' }))).toBe('call_done');
    expect(deriveOutreachStage(signals({ stageOverride: 'contacted', hasReferral: true }))).toBe('contacted');
  });

  it('unrecognized override values fall through to derivation', () => {
    expect(deriveOutreachStage(signals({ stageOverride: 'emailed_2x', hasReply: true }))).toBe('replied');
    expect(deriveOutreachStage(signals({ stageOverride: 'weird' }))).toBe('not_contacted');
  });
});

describe('stageRank', () => {
  it('orders stages for traction sorting', () => {
    expect(stageRank('referral')).toBeGreaterThan(stageRank('call_done'));
    expect(stageRank('call_done')).toBeGreaterThan(stageRank('call_scheduled'));
    expect(stageRank('call_scheduled')).toBeGreaterThan(stageRank('replied'));
    expect(stageRank('replied')).toBeGreaterThan(stageRank('bounced'));
    expect(stageRank('bounced')).toBeGreaterThan(stageRank('contacted'));
    expect(stageRank('contacted')).toBeGreaterThan(stageRank('not_contacted'));
  });
});
