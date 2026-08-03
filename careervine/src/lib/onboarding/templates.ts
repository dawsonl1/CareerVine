import { abbrFor } from "@/lib/schools/affinity";

/**
 * Static merge-field email templates for guided onboarding (CAR-50).
 *
 * CAR-213 removed TWO false claims these made about the sender. The obvious
 * one was the school: the alumni variant said "a fellow Cougar", which is only
 * true for a BYU sender. The worse one was in the variant that exists
 * SPECIFICALLY to avoid claiming a connection that is not there — it still
 * opened "I'm a student at BYU", so a non-BYU user's very first outreach email
 * asserted a school they never attended.
 *
 * The enrollment claim went too, not just the school. CareerVine models
 * student-vs-professional status precisely for CONTACTS and not at all for the
 * account holder, so "a student" was never something this code could know. A
 * career changer, an MBA grad, or anyone two years out sent an email that
 * misrepresented them, in the highest-stakes moment the product has: the
 * guided flow's whole purpose is that this email really goes out, often
 * unedited, in the first ten minutes.
 *
 * "working toward a career in product management" is true for every user and
 * costs nothing.
 *
 * These are deliberately NOT AI-generated: every new user gets the full
 * first-email flow with zero AI entitlement (no BYO key, no shared-key
 * trial). The user edits freely in the composer before sending, so the
 * templates only need to be a strong, honest starting point.
 *
 * Two intro variants — the alumni one leans on the shared-school
 * connection (highest reply rate for students); the general one doesn't
 * pretend a connection that isn't there.
 */

export type MergeContext = {
  contactFirstName?: string | null;
  companyName?: string | null;
  senderFirstName?: string | null;
  /** The sender's own school, for the alumni variant (CAR-213). Null means
   * they claimed none, which forces the school-neutral variant. */
  senderSchool?: string | null;
};

export type RenderedEmail = {
  subject: string;
  bodyHtml: string;
};

export type RenderedFollowUp = RenderedEmail & {
  delayDays: number;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Merge values come from scraped contact data — escape them so a name like
// O'Brien <Consulting> can't break the composer's HTML or smuggle markup.
function fields(ctx: MergeContext) {
  const first = ctx.contactFirstName?.trim();
  const company = ctx.companyName?.trim();
  const sender = ctx.senderFirstName?.trim();
  return {
    first_name: first ? escapeHtml(first) : "there",
    company: company ? escapeHtml(company) : "your company",
    sender_first_name: sender ? escapeHtml(sender) : "",
    // Plain-text (unescaped) variants for subject lines.
    subject_company: company ?? "your company",
  };
}

function paragraphs(...lines: string[]): string {
  return lines.map((line) => `<p>${line}</p>`).join("");
}

// Sign-off collapses cleanly when we don't know the sender's name yet.
function signOff(senderFirstName: string): string {
  return senderFirstName
    ? `<p>Thanks so much,<br/>${senderFirstName}</p>`
    : `<p>Thanks so much!</p>`;
}

export function renderOnboardingIntro(
  ctx: MergeContext & { isAlum: boolean },
): RenderedEmail {
  const f = fields(ctx);

  // The alumni variant needs BOTH a shared school and one we can name. An
  // escape-hatch school has no abbreviation, and "a fellow alum" without
  // saying of what reads as a form letter — so those senders get the neutral
  // variant, which is honest rather than vague.
  const school = ctx.senderSchool?.trim() || null;
  const schoolLabel = abbrFor(school) ?? school;

  if (ctx.isAlum && schoolLabel) {
    const s = escapeHtml(schoolLabel);
    return {
      subject: `${schoolLabel} connection who would love to hear about your path to ${f.subject_company}`,
      bodyHtml:
        paragraphs(
          `Hi ${f.first_name},`,
          `I'm ${f.sender_first_name ? `${f.sender_first_name}, ` : ""}working toward a career in product, and it was genuinely encouraging to find a fellow ${s} alum at ${f.company}.`,
          `Would you be open to a quick 15&ndash;20 minute chat in the next couple of weeks? I'd love to hear how you got from ${s} to ${f.company}, and any advice you'd give someone starting the same climb.`,
        ) + signOff(f.sender_first_name),
    };
  }

  return {
    subject: `Interested in product at ${f.subject_company}`,
    bodyHtml:
      paragraphs(
        `Hi ${f.first_name},`,
        `I'm ${f.sender_first_name ? `${f.sender_first_name}, ` : ""}working toward a career in product management, and your role at ${f.company} stood out while I was researching teams whose work I admire.`,
        `Would you be open to a quick 15&ndash;20 minute chat in the next couple of weeks? I'd love to hear how you got into product at ${f.company} and what you'd look for in someone just starting out.`,
      ) + signOff(f.sender_first_name),
  };
}

// Default cadence per the onboarding flow: three touches, a week apart.
// delayDays is an ABSOLUTE offset from the original send (the follow-up
// route schedules each step at originalSentAt + delayDays, same as the AI
// path's [7, 14, 21]) — NOT an inter-step gap. Auto-cancelled by the
// sequence cron if the prospect replies.
export const ONBOARDING_FOLLOW_UP_DELAYS = [7, 14, 21] as const;

export function renderOnboardingFollowUps(ctx: MergeContext): RenderedFollowUp[] {
  const f = fields(ctx);
  const [d1, d2, d3] = ONBOARDING_FOLLOW_UP_DELAYS;

  return [
    {
      subject: `Quick follow-up`,
      delayDays: d1,
      bodyHtml:
        paragraphs(
          `Hi ${f.first_name},`,
          `Just floating this back to the top of your inbox. I know things get busy, and I'd still love 15 minutes to hear about your work at ${f.company} whenever it's convenient.`,
        ) + signOff(f.sender_first_name),
    },
    {
      subject: `Still hoping to connect`,
      delayDays: d2,
      bodyHtml:
        paragraphs(
          `Hi ${f.first_name},`,
          `Wanted to try once more. I completely understand if now isn't a good time. If it's easier, I'd also be happy to send over two or three questions by email instead of finding a meeting slot.`,
        ) + signOff(f.sender_first_name),
    },
    {
      subject: `Last note from me`,
      delayDays: d3,
      bodyHtml:
        paragraphs(
          `Hi ${f.first_name},`,
          `I'll stop cluttering your inbox after this one. If a chat ever sounds doable, I'd genuinely love to hear from you, and either way, thanks for the example your path provides to those of us just getting started.`,
        ) + (f.sender_first_name ? `<p>Best,<br/>${f.sender_first_name}</p>` : `<p>Best!</p>`),
    },
  ];
}
