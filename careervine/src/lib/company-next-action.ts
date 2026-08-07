/**
 * Next-action derivation for the Companies list (CAR-10).
 *
 * The companies page exists to answer one question fast: *what do I do next
 * for this company?* This turns the signals already on a CompanySummary
 * (pipeline status, application deadline, outreach traction, who you know)
 * into a single, concrete next move plus a `rank` that drives the default
 * "What's next" sort.
 *
 * Pure and React-free so the ladder is unit-testable and reusable. `now` is
 * injectable for deterministic tests. Icons are returned as lucide-react
 * names; the card maps them to components.
 */

import type { CompanySummary, ReplyThreadState } from "./company-queries";
import type { ConversationKind, OutreachStage } from "./stage-derivation";
import { formatTimeAgo } from "./relative-time";

export type NextActionTone = "urgent" | "active" | "muted";

export interface NextAction {
  /** The concrete next move, e.g. "Reach out to Sarah, your alum here". */
  text: string;
  /** lucide-react icon name the card maps to a component. */
  icon: string;
  /** Visual urgency: urgent (needs you now) → active (a live move) → muted (dormant). */
  tone: NextActionTone;
  /** Higher = more deserving of attention; drives the "What's next" sort. */
  rank: number;
}

export interface NextActionInput {
  /** target_companies.status, or null when the company isn't a formal target. */
  status: string | null;
  /** Nearest application deadline (YYYY-MM-DD) across targeted scopes, if any. */
  nextAppDate: string | null;
  /** Max derived outreach stage across the company's contacts. */
  traction: OutreachStage | null;
  /** Current non-bench contacts you know here. */
  currentCount: number;
  /** Alumni of the VIEWER's school among them — the warmest intro. */
  alumCount: number;
  /** Viewer's-school alumni in a product role — the highest-value intro. */
  productAlumCount: number;
  /** Recruiters among them. */
  recruiterCount: number;
  /** The person to name in the line (already chosen upstream); null if none. */
  leadName: string | null;
  /**
   * When we last reached out to the lead, so a waiting line can say how long it
   * has been instead of "if it's been a while" (CAR-253). Null drops the clause.
   */
  lastOutreachAt: string | null;
  /**
   * The lead's reply conversation, when one backs a `replied` traction. Null
   * means "no evidence either way" — a stage_override, or a caller that has not
   * computed it — and the ladder falls back to the write-back prompt, which is
   * the assumption that costs a wasted glance rather than a missed reply.
   */
  replyThread: ReplyThreadState | null;
  /**
   * What the conversation behind a `call_done` / `call_scheduled` traction
   * actually was (CAR-257). Null means no type was recorded, which the two call
   * rungs read as a call — a Google-synced calendar event carries no type, and
   * treating those as unknown would silence every real call on the list.
   */
  conversationKind: ConversationKind | null;
  /**
   * When that conversation happened — for the lines that state a date, and the
   * timestamp the two "what happened since the call" checks order against
   * (CAR-266). The adapter feeds the LEAD's own latest conversation here, not
   * the company-merged `traction_detail.at`, so the date, the name, the kind
   * and the follow-up evidence all describe one person.
   */
  conversationAt: string | null;
}

/** Whole days from `now` (local midnight) to a YYYY-MM-DD date; negative = past. */
export function daysUntil(dateStr: string, now: Date): number {
  const target = new Date(`${dateStr}T00:00:00`);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** First name reads warmer in an action line than the full name. */
function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/**
 * "They replied, you owe them a response." Shared by the `replied` rung and the
 * post-conversation promotion in the `call_done` rung (CAR-266) so the two
 * cannot drift apart in wording or rank.
 */
function writeBackAction(lead: string | null): NextAction {
  return {
    text: lead ? `${lead} replied, write back` : "You have a reply, write back",
    icon: "MailOpen",
    tone: "active",
    rank: 84,
  };
}

/**
 * The kinds whose past-conversation line is a follow-up PROMPT (see
 * pastConversationAction). Only a prompt can be retired by the follow-up having
 * happened — text and Other already render statements.
 */
const FOLLOW_UP_PROMPT_KINDS: ReadonlySet<ConversationKind> = new Set(["call", "career-fair", "networking"]);

/**
 * The "you already had this conversation, now follow up" rung, worded for what
 * the conversation actually was (CAR-257).
 *
 * Text Message Chat and Other deliberately return no PROMPT. Following up after
 * a text exchange is not a move the app should push — Lucid Software advised
 * "Follow up with Spencer after your call" off a meeting titled "LinkedIn
 * chat", and the correction is not better wording for the same nudge, it is not
 * nudging. Those two state the fact instead, at a rank below every real move
 * (the warm-intro band bottoms out at 34) so a dead end never wins the
 * "What's next" sort.
 */
function pastConversationAction(
  kind: ConversationKind,
  lead: string | null,
  at: string | null,
  now: Date,
): NextAction {
  switch (kind) {
    case "career-fair":
      return {
        text: lead ? `Follow up with ${lead} after the career fair` : "Follow up after the career fair",
        icon: "Briefcase",
        tone: "active",
        rank: 65,
      };
    case "networking":
      return {
        text: lead ? `Follow up with ${lead} after the networking event` : "Follow up after the networking event",
        icon: "Users",
        tone: "active",
        rank: 65,
      };
    case "text":
    case "other": {
      // "You texted Spencer 1 month ago" — a statement, so the time clause is
      // what carries it. Without a usable date it degrades to the bare fact
      // rather than inventing one.
      //
      // formatTimeAgo, not formatRelativeTime (CAR-253's helper): this sentence
      // can only be read in the past tense, and a meeting_date is hand-entered,
      // so a future one must drop the clause rather than render "in 3 days".
      const when = formatTimeAgo(at, now);
      const verb = kind === "text" ? "texted" : "connected with";
      const who = lead ?? "someone here";
      return {
        text: when ? `You ${verb} ${who} ${when}` : `You ${verb} ${who}`,
        icon: kind === "text" ? "MessageSquare" : "CircleEllipsis",
        tone: "muted",
        rank: 30,
      };
    }
    case "call":
      return {
        text: lead ? `Follow up with ${lead} after your call` : "Follow up after your call",
        icon: "MessageSquare",
        tone: "active",
        rank: 65,
      };
  }
}

/**
 * The "a conversation is on the calendar" rung, worded for what it is
 * (CAR-257). Same defect as the rung above, one step earlier: a career fair
 * synced to Google Calendar used to read "Prep for your call".
 *
 * Text and Other collapse to the neutral "conversation" — you do not schedule
 * a text exchange, so anything that lands here is a mislabel, and a generic
 * word is the one wording that cannot be wrong about it.
 */
function upcomingConversationAction(kind: ConversationKind, lead: string | null): NextAction {
  const base = { icon: "Phone", tone: "active" as const, rank: 86 };
  switch (kind) {
    case "career-fair":
      return { ...base, icon: "Briefcase", text: lead ? `Prep for the career fair, ${lead} will be there` : "Prep for the career fair" };
    case "networking":
      return { ...base, icon: "Users", text: lead ? `Prep for the networking event, ${lead} will be there` : "Prep for the networking event" };
    case "text":
    case "other":
      return { ...base, icon: "MessageSquare", text: lead ? `Prep for your conversation with ${lead}` : "Prep for your upcoming conversation" };
    case "call":
      return { ...base, text: lead ? `Prep for your call with ${lead}` : "Prep for your upcoming call" };
  }
}

/**
 * The single most useful next move for a company. The ladder is ordered by
 * what a job-seeker should actually do first: finish live conversations and
 * beat hard deadlines before starting cold ones, and always prefer a warm
 * (alumni) intro over a generic one.
 *
 * Null means there is genuinely nothing to say, which happens only when you
 * know nobody currently inside the company and it carries no deadline or
 * pipeline state of its own. The card renders no pill at all there; see the
 * bottom of the ladder.
 */
export function deriveNextAction(input: NextActionInput, now: Date = new Date()): NextAction | null {
  const { status, nextAppDate, traction, currentCount, alumCount, productAlumCount, replyThread } = input;
  const lead = firstName(input.leadName);
  // Untyped means a call — see NextActionInput.conversationKind.
  const conversation = input.conversationKind ?? "call";

  // Closed — nothing left to do.
  if (status === "closed") {
    return { text: "Closed", icon: "Archive", tone: "muted", rank: 5 };
  }

  // Interviewing — furthest along; protect the momentum.
  if (status === "interviewing") {
    return { text: "Interviewing, so prep for your next round", icon: "Sparkles", tone: "urgent", rank: 100 };
  }

  const deadlineDays = nextAppDate && status !== "applied" ? daysUntil(nextAppDate, now) : null;

  // Imminent deadline (≤7 days) — a hard event that outranks everything but interviewing.
  if (deadlineDays != null && deadlineDays >= 0 && deadlineDays <= 7) {
    const when = deadlineDays === 0 ? "today" : deadlineDays === 1 ? "tomorrow" : `in ${deadlineDays} days`;
    return { text: `Apply ${when}, closes ${shortDate(nextAppDate!)}`, icon: "CalendarClock", tone: "urgent", rank: 90 + (7 - deadlineDays) };
  }

  // Live inbound threads — the most actionable warm state.
  if (traction === "referral") {
    return { text: lead ? `${lead} offered a referral, line up the intro` : "You have a referral, line up the intro", icon: "Handshake", tone: "active", rank: 88 };
  }
  if (traction === "call_scheduled") {
    return upcomingConversationAction(conversation, lead);
  }
  // A reply we have not answered. `replied` alone is NOT enough: the stage is
  // sticky, so testing it by itself kept demanding a write-back on threads
  // where the last word was already ours (CAR-253). A null replyThread means
  // nobody computed it, and defaults to prompting — the cheap error.
  if (traction === "replied" && (replyThread?.awaitingOurReply ?? true)) {
    return writeBackAction(lead);
  }

  // Mid-range deadline (8–21 days) — worth surfacing, below live threads.
  if (deadlineDays != null && deadlineDays >= 8 && deadlineDays <= 21) {
    return { text: `Apply in ${deadlineDays} days, closes ${shortDate(nextAppDate!)}`, icon: "CalendarClock", tone: "active", rank: 70 + (21 - deadlineDays) };
  }

  // Conversation started but no live thread. What happened SINCE the
  // conversation decides the line (CAR-266): `call_done` is sticky, so reading
  // only the conversation kept prompting "Follow up with Lance after your call"
  // long after the thank-you email had gone out. Both checks need a dated
  // conversation to order against; without one (a bare stage_override) the
  // prompt stands, the same cheap-error default the replied rung uses.
  if (traction === "call_done") {
    const conversationAt = input.conversationAt;
    // They wrote after the conversation and the thread is still ours to answer:
    // responding IS the follow-up, so the write-back line replaces the nudge.
    // Gated on the reply POSTDATING the conversation, because an unanswered
    // scheduling reply from before a call was answered by the call itself —
    // resurrecting it would undo CAR-253's point.
    if (
      conversationAt &&
      replyThread?.awaitingOurReply &&
      replyThread.lastUnansweredReplyAt &&
      replyThread.lastUnansweredReplyAt > conversationAt
    ) {
      return writeBackAction(lead);
    }
    // You already followed up — any outbound touch after the conversation — so
    // the prompt's task is done and it becomes a statement, ranked with the
    // other ball-in-their-court states (answered thread 58, applied 62). The
    // clause dates the follow-up, not the call. Strict `>` on purpose: a
    // conversation double-logged as an interaction at the same instant must not
    // read as a follow-up to itself. Known fuzz: a hand-logged meeting_date is
    // a wall clock stored as UTC (CAR-206), so a same-day PRE-call email can
    // compare as later in western timezones — the cost is retiring the prompt a
    // few hours early, accepted.
    if (
      conversationAt &&
      input.lastOutreachAt &&
      input.lastOutreachAt > conversationAt &&
      FOLLOW_UP_PROMPT_KINDS.has(conversation)
    ) {
      const when = formatTimeAgo(input.lastOutreachAt, now);
      const who = lead ? ` with ${lead}` : "";
      return {
        text: when ? `You followed up${who} ${when}` : `You followed up${who}`,
        icon: "MailCheck",
        tone: "muted",
        rank: 60,
      };
    }
    return pastConversationAction(conversation, lead, conversationAt, now);
  }

  // Applied — nudge toward a human to back the application. With nobody current
  // to nudge toward, there is no move to name: the status chip already says
  // "Applied", so a pill repeating it and adding "find someone" is filler
  // (CAR-246).
  if (status === "applied") {
    return currentCount > 0
      ? { text: "Applied, so ask a contact to refer you", icon: "Send", tone: "active", rank: 62 }
      : null;
  }

  // A reply we already answered. Reaching here means the live-inbound rung
  // above declined it, so the ball is in their court — the same posture as
  // `contacted`, and ranked with it rather than up at 84 where an unanswered
  // reply sits. Warmer than a cold outreach (56), colder than an application
  // that wants a referral (62).
  if (traction === "replied") {
    const when = formatTimeAgo(replyThread?.lastMessageAt ?? null, now);
    const who = lead ? ` with ${lead}` : "";
    return {
      text: `You had an email thread${who}${when ? ` (${when})` : ""}`,
      icon: "MailCheck",
      tone: "muted",
      rank: 58,
    };
  }

  // Contacted / bounced — you've already engaged, so this outranks a cold
  // warm-intro below: momentum leads.
  if (traction === "contacted") {
    // "Follow up if it's been a while" made the reader go work out how long it
    // had been; the date is right here (CAR-253). It survives only as the
    // fallback for a touch we hold no usable date for.
    const when = formatTimeAgo(input.lastOutreachAt, now);
    const text = lead
      ? when
        ? `Waiting on ${lead}. You reached out ${when}`
        : `Waiting on ${lead}. Follow up if it's been a while`
      : when
        ? `No reply yet. You reached out ${when}`
        : "No reply yet. Follow up";
    return { text, icon: "Clock", tone: "muted", rank: 56 };
  }
  if (traction === "bounced") {
    return { text: "An email bounced. Find another way in", icon: "MailX", tone: "muted", rank: 52 };
  }

  // Warm but untouched — a real opportunity, but deliberately ranked below
  // anything you've already started so momentum stays on top. Within the warm
  // band, an alum of your school in product is the highest-value intro.
  // alumCount/productAlumCount are already viewer-scoped by company-queries,
  // so these lines simply never fire for a user with no school (CAR-213).
  if ((traction == null || traction === "not_contacted") && currentCount > 0) {
    if (productAlumCount > 0) {
      return {
        text: lead ? `Reach out to ${lead}, your alum in product` : "Reach out to your alum in product",
        icon: "GraduationCap",
        tone: "active",
        rank: 44,
      };
    }
    if (alumCount > 0) {
      return { text: lead ? `Reach out to ${lead}, your alum here` : "Reach out to your alum here", icon: "GraduationCap", tone: "active", rank: 40 };
    }
    return {
      text: lead ? `Reach out to ${lead}` : `Reach out, you know ${currentCount} ${currentCount === 1 ? "person" : "people"} here`,
      icon: "UserPlus",
      tone: "active",
      rank: 34,
    };
  }

  // Past-due deadline that was never marked applied.
  if (deadlineDays != null && deadlineDays < 0) {
    return { text: `Applications closed ${shortDate(nextAppDate!)}. Mark applied or move on`, icon: "CalendarX", tone: "muted", rank: 22 };
  }

  // Targeted, nobody currently inside. There is no next move that this card can
  // name, so it says nothing rather than filling the slot with "find people"
  // (CAR-246). Reaching here means currentCount is 0: every traction rung needs
  // a current contact, and the warm-intro rungs above test for one explicitly.
  //
  // Company-level rungs still fire before this — a deadline, Interviewing, or
  // Closed is a fact about the application, not about who you know, and an
  // application closing in three days is exactly the pill worth showing to
  // someone who knows nobody there yet.
  return null;
}

/**
 * Rank for a company the ladder has nothing to say about. Below every real
 * rung (the lowest is Closed at 5), so the "What's next" sort parks these at
 * the bottom instead of dropping them out of the list.
 */
export const NO_ACTION_RANK = 0;

/** Adapt a CompanySummary to the next-action ladder. */
export function nextActionForCompany(c: CompanySummary, now: Date = new Date()): NextAction | null {
  return deriveNextAction(
    {
      status: c.target?.status ?? null,
      nextAppDate: c.target?.next_app_date ?? null,
      traction: c.traction,
      currentCount: c.current_count,
      alumCount: c.alum_count,
      productAlumCount: c.product_alum_count,
      recruiterCount: c.recruiter_count,
      leadName: c.lead_contact_name,
      lastOutreachAt: c.lead_detail?.last_outreach_at ?? null,
      replyThread: c.lead_detail?.reply ?? null,
      conversationKind: c.conversation?.kind ?? null,
      // The lead's own conversation, falling back to the company-merged
      // timestamp only when the lead has none to offer (a stage_override
      // asserting call_done while someone else at the company had the real
      // conversation) — there the date is still truer than nothing.
      conversationAt: c.lead_detail?.last_conversation_at ?? c.traction_detail?.at ?? null,
    },
    now,
  );
}
