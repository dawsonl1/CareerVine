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

import type { CompanySummary } from "./company-queries";
import type { OutreachStage } from "./stage-derivation";

export type NextActionTone = "urgent" | "active" | "muted";

export interface NextAction {
  /** The concrete next move, e.g. "Reach out to Sarah — your BYU alum here". */
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
  /** BYU alumni among them — the warmest intro. */
  alumCount: number;
  /** BYU alumni among them who are in a product role — the highest-value intro for a PM search. */
  productAlumCount: number;
  /** Recruiters among them. */
  recruiterCount: number;
  /** The person to name in the line (already chosen upstream); null if none. */
  leadName: string | null;
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
 */
export function deriveNextAction(input: NextActionInput, now: Date = new Date()): NextAction {
  const { status, nextAppDate, traction, currentCount, alumCount, productAlumCount } = input;
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
  if (traction === "replied") {
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

  // Applied — nudge toward a human to back the application.
  if (status === "applied") {
    return currentCount > 0
      ? { text: "Applied, so ask a contact to refer you", icon: "Send", tone: "active", rank: 62 }
      : { text: "Applied. Find someone here to back you up", icon: "Send", tone: "muted", rank: 48 };
  }

  // Contacted / bounced — you've already engaged, so this outranks a cold
  // warm-intro below: momentum leads.
  if (traction === "contacted") {
    return { text: lead ? `Waiting on ${lead}. Follow up if it's been a while` : "No reply yet. Follow up", icon: "Clock", tone: "muted", rank: 56 };
  }
  if (traction === "bounced") {
    return { text: "An email bounced. Find another way in", icon: "MailX", tone: "muted", rank: 52 };
  }

  // Warm but untouched — a real opportunity, but deliberately ranked below
  // anything you've already started so momentum stays on top. Within the warm
  // band, a BYU alum in product is the highest-value intro for a PM search.
  if ((traction == null || traction === "not_contacted") && currentCount > 0) {
    if (productAlumCount > 0) {
      return {
        text: lead ? `Reach out to ${lead}, your BYU alum in product` : "Reach out to your BYU alum in product",
        icon: "GraduationCap",
        tone: "active",
        rank: 44,
      };
    }
    if (alumCount > 0) {
      return { text: lead ? `Reach out to ${lead}, your BYU alum here` : "Reach out to your BYU alum here", icon: "GraduationCap", tone: "active", rank: 40 };
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

  // Targeted, nobody known yet.
  return { text: "Find people who work here", icon: "Search", tone: "muted", rank: 30 };
}

/** Adapt a CompanySummary to the next-action ladder. */
export function nextActionForCompany(c: CompanySummary, now: Date = new Date()): NextAction {
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
    },
    now,
  );
}
