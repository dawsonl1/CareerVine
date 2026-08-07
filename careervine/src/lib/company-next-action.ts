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
import type { OutreachStage } from "./stage-derivation";
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
    return { text: lead ? `Prep for your call with ${lead}` : "Prep for your upcoming call", icon: "Phone", tone: "active", rank: 86 };
  }
  // A reply we have not answered. `replied` alone is NOT enough: the stage is
  // sticky, so testing it by itself kept demanding a write-back on threads
  // where the last word was already ours (CAR-253). A null replyThread means
  // nobody computed it, and defaults to prompting — the cheap error.
  if (traction === "replied" && (replyThread?.awaitingOurReply ?? true)) {
    return { text: lead ? `${lead} replied, write back` : "You have a reply, write back", icon: "MailOpen", tone: "active", rank: 84 };
  }

  // Mid-range deadline (8–21 days) — worth surfacing, below live threads.
  if (deadlineDays != null && deadlineDays >= 8 && deadlineDays <= 21) {
    return { text: `Apply in ${deadlineDays} days, closes ${shortDate(nextAppDate!)}`, icon: "CalendarClock", tone: "active", rank: 70 + (21 - deadlineDays) };
  }

  // Conversation started but no live thread.
  if (traction === "call_done") {
    return { text: lead ? `Follow up with ${lead} after your call` : "Follow up after your call", icon: "MessageSquare", tone: "active", rank: 65 };
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
    },
    now,
  );
}
