/**
 * Derived outreach stage (plan 24 Phase 3).
 *
 * The stage is computed from real activity signals rather than stored —
 * with one escape hatch: contacts.stage_override (set manually or by the
 * tracker import) wins over everything. Purely-derived with no escape
 * hatch is elegant and wrong (outreach happens on LinkedIn too).
 *
 * Later signals win: referral > call_done > call_scheduled > replied >
 * bounced > contacted > not_contacted. Bounced is surfaced distinctly —
 * a bounce is never presented as "no reply yet".
 */

export type OutreachStage =
  | "not_contacted"
  | "contacted"
  | "replied"
  | "bounced"
  | "call_scheduled"
  | "call_done"
  | "referral";

export const STAGE_ORDER: OutreachStage[] = [
  "not_contacted",
  "contacted",
  "bounced",
  "replied",
  "call_scheduled",
  "call_done",
  "referral",
];

export const STAGE_LABELS: Record<OutreachStage, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  bounced: "Bounced",
  replied: "Replied",
  call_scheduled: "Call scheduled",
  call_done: "Call done",
  referral: "Referral",
};

export interface StageSignals {
  /** contacts.stage_override — wins over every derived signal. */
  stageOverride?: string | null;
  /** referrals row exists with this contact as referrer (existence, not count). */
  hasReferral: boolean;
  /** A linked meeting / calendar event in the past. */
  hasPastCall: boolean;
  /** A linked upcoming calendar event / meeting. */
  hasUpcomingCall: boolean;
  /**
   * A real inbound email (is_simulated = false) SENT BY this contact, dated on
   * or after our first outbound to them. On a thread shared with several
   * contacts, only the actual sender counts — cc'd co-recipients do not (the
   * caller attributes inbound by from_address, CAR-159).
   */
  hasReply: boolean;
  /** Outbound matched email (is_simulated = false). */
  hasOutboundEmail: boolean;
  /** Any logged interaction — email is not the only channel. */
  hasInteraction: boolean;
  /** A contact email has bounced_at set. */
  hasBouncedEmail: boolean;
}

const VALID_STAGES = new Set<string>(STAGE_ORDER);

export function deriveOutreachStage(s: StageSignals): OutreachStage {
  // Manual override wins — but only recognized values (tracker stages that
  // don't map to ours fall through to derivation rather than rendering
  // arbitrary strings)
  if (s.stageOverride && VALID_STAGES.has(s.stageOverride)) {
    return s.stageOverride as OutreachStage;
  }

  if (s.hasReferral) return "referral";
  if (s.hasPastCall) return "call_done";
  if (s.hasUpcomingCall) return "call_scheduled";
  if (s.hasReply) return "replied";

  const contacted = s.hasOutboundEmail || s.hasInteraction;
  if (s.hasBouncedEmail && contacted) return "bounced";
  if (contacted) return "contacted";
  return "not_contacted";
}

/** Rank for traction sorting (higher = further along). */
export function stageRank(stage: OutreachStage): number {
  return STAGE_ORDER.indexOf(stage);
}
