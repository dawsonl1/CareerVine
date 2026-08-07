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

import { ConversationType } from "./constants";

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

/**
 * Counted labels for the companies-list traction chip (CAR-246), which reads
 * "2 Calls Done (2 weeks ago)" rather than a bare stage name.
 *
 * Separate from STAGE_LABELS on purpose: that map labels ONE person's stage on
 * the outreach page, the person modal and the pipeline board, where a count
 * would be meaningless. Only the company chip aggregates, so only it pluralizes.
 *
 * "Contacted" and "Bounced" are past participles describing the people, not
 * countable nouns, so they do not inflect: "3 Contacted", not "3 Contacteds".
 */
export const STAGE_CHIP_LABELS: Record<OutreachStage, { one: string; many: string }> = {
  not_contacted: { one: "Not contacted", many: "Not contacted" },
  contacted: { one: "Contacted", many: "Contacted" },
  bounced: { one: "Bounced", many: "Bounced" },
  replied: { one: "Reply", many: "Replies" },
  call_scheduled: { one: "Call Scheduled", many: "Calls Scheduled" },
  call_done: { one: "Call Done", many: "Calls Done" },
  referral: { one: "Referral", many: "Referrals" },
};

// ── What KIND of conversation a call stage is made of (CAR-257) ────────

/**
 * The conversation vocabulary as the two call stages need to read it.
 *
 * `call_done` / `call_scheduled` are named for the common case, but CAR-242 let
 * a user log a career fair, a networking event or a text exchange as the same
 * kind of record. Without this, Lucid Software's card advised "Follow up with
 * Spencer after your call" off a meeting literally titled "LinkedIn chat".
 *
 * `coffee` collapses to `call` on purpose: CAR-242 made Coffee Chat the 1:1
 * bucket REGARDLESS OF MEDIUM, so phone and video calls live there and nowhere
 * else.
 */
export type ConversationKind = "call" | "career-fair" | "networking" | "text" | "other";

const CONVERSATION_KIND_BY_TYPE: Record<string, ConversationKind> = {
  [ConversationType.Coffee]: "call",
  [ConversationType.CareerFair]: "career-fair",
  [ConversationType.Networking]: "networking",
  [ConversationType.Text]: "text",
  [ConversationType.Other]: "other",
};

/**
 * The kind behind a stored `meeting_type`, or NULL when there is no type to
 * read — an absent value, or one predating CAR-242's vocabulary.
 *
 * Null rather than a `"call"` default, because the two are not the same claim
 * and the difference decides a dedupe. A Google-synced calendar event carries
 * no type at all, and a meeting mirroring that event is the ONLY leg that knows
 * what the conversation was; if this returned `"call"` the calendar leg would
 * overwrite the meeting's real kind (see `noteEvent` in company-queries).
 * Callers resolve the default themselves, at the point where "we know nothing"
 * really does mean "assume it was a call".
 */
export function conversationKind(type: string | null | undefined): ConversationKind | null {
  if (!type) return null;
  return CONVERSATION_KIND_BY_TYPE[type] ?? null;
}

/**
 * The chip noun for a call stage whose conversations were not all calls
 * (CAR-257): "1 Conversation (1 month ago)", "2 Conversations Scheduled".
 *
 * Deliberately a superset word rather than a per-type noun. A company can hold
 * a career fair chat and a text exchange behind one chip, and "2 Conversations"
 * is true of any mix — where naming either type would be false of the other.
 */
export const CONVERSATION_CHIP_LABELS: Record<"call_done" | "call_scheduled", { one: string; many: string }> = {
  call_done: { one: "Conversation", many: "Conversations" },
  call_scheduled: { one: "Conversation Scheduled", many: "Conversations Scheduled" },
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
