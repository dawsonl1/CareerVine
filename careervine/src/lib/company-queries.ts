/**
 * Company-page data layer (plan 24 Phase 3).
 *
 * getCompanies powers /companies (target dashboard + all-companies search);
 * getCompanyDetail powers /companies/[id] with location facets and the
 * current/former/bench split. Bench containment is enforced here: bench
 * people are returned in their own list, never mixed into contact counts
 * or traction.
 *
 * ── The `enrich` option (CAR-229) ────────────────────────────────────────
 *
 * getCompanies' who-you-know pass (alum/product-alum/recruiter counts,
 * traction, lead name) is the bulk of what the call costs: it fans the shown
 * companies out to their people, then fans those people out to eight stage legs
 * plus an alumni lookup. `enrich: false` skips all of it for a caller that
 * renders none of those five fields, and the RESULT TYPE CHANGES with it —
 * CompanyBaseSummary simply does not carry them, so a consumer cannot read a
 * count that was never computed. That is the whole point of the option: the
 * cheap way to add it would have been to leave `alum_count: 0` in place, which
 * is indistinguishable from "nobody here went to your school".
 *
 * Two sorts read the enrichment (`next` through nextActionForCompany, and
 * `traction` directly), so `enrich: false` requires an explicit `sort` from the
 * narrowed set. Defaulting would have silently picked `next` for the
 * pursuing/in_play scopes.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import {
  deriveOutreachStage,
  stageRank,
  STAGE_ORDER,
  type OutreachStage,
  type StageSignals,
} from "./stage-derivation";
import { chunked, chunkedPaginated, paginateAll, escapeIlike } from "@/lib/data/postgrest";
import { must } from "@/lib/data/client";
import { getUserSchool } from "@/lib/data/users";
import { findOrCreateCompany } from "./company-helpers";
import { nextActionForCompany, NO_ACTION_RANK } from "./company-next-action";
import { isByuFamilySchool, schoolsMatch } from "@/lib/schools/affinity";
import { sortExperiences } from "@/lib/experience-order";
import { conversationTypeLabel } from "@/lib/constants";

type QueryClient = ReturnType<typeof createSupabaseBrowserClient>;

// Client is resolved lazily so this module can run outside the browser:
// the MCP server injects a service-role client (all queries here are
// explicitly user_id-scoped, so bypassing RLS is safe); the app falls
// back to the usual browser singleton on first use.
let injectedClient: QueryClient | null = null;
let browserClient: QueryClient | null = null;

export function setCompanyQueriesClient(client: QueryClient) {
  injectedClient = client;
}

function db(): QueryClient {
  if (injectedClient) return injectedClient;
  if (!browserClient) browserClient = createSupabaseBrowserClient();
  return browserClient;
}

// ── Shared helpers ─────────────────────────────────────────────────────

/** Pipeline personas that count as "in a product role" for the product-alum signal. */
export const PRODUCT_PERSONAS = new Set(["product_leader", "alum_product", "product_peer"]);

/**
 * The viewing user's own school, read once per page load (CAR-213).
 *
 * Resolved HERE rather than passed in by every caller, for the same reason the
 * sync resolves it internally: the alum signal feeds four badge components, a
 * filter chip, a sort, and the next-action line, and a caller that forgot to
 * thread it would light "your alum" badges on strangers with no error anywhere.
 * One extra single-row read per page buys that.
 *
 * public.users is canonical; the user_metadata mirror the client hook reads is
 * user-writable and must never gate data.
 */
async function viewerSchool(userId: string): Promise<string | null> {
  // Explicitly on THIS module's client seam, not the data layer's.
  return getUserSchool(userId, db() as never);
}

/**
 * Batch-resolve which of the given contacts went to the VIEWER's school
 * (contact_schools → schools.name match). Complements contacts.verified_school
 * for the who-you-know alum signal on the companies list.
 *
 * Empty when the viewer has no school: nothing is "your school" if you have
 * not named one, so nothing gets badged.
 */
async function alumContactIds(contactIds: number[], userSchool: string | null): Promise<Set<number>> {
  const out = new Set<number>();
  if (contactIds.length === 0 || !userSchool) return out;
  const rows = await chunked(contactIds, async (chunk) => {
    return (
      must(await db().from("contact_schools").select("contact_id, schools(name)").in("contact_id", chunk)) ?? []
    );
  });
  for (const s of rows) {
    if (schoolsMatch(s.schools?.name, userSchool)) out.add(s.contact_id);
  }
  return out;
}

/**
 * The second alum signal: contacts.verified_school, a human-verified override
 * from the pipeline for profiles whose scraped education omitted the school.
 *
 * BYU-ONLY BY CONSTRUCTION — the column's CHECK pins it to
 * ('BYU','BYU-Idaho','Marriott','none'), so no other school can ever appear
 * there. It therefore counts only for a BYU-family viewer; leaving it on for
 * everyone would badge a BYU alum as, say, a Utah State user's own alum.
 */
function verifiedSchoolCounts(verified: string | null, userSchool: string | null): boolean {
  if (!verified || verified === "none") return false;
  return isByuFamilySchool(userSchool);
}

// ── Stage signals (batch) ──────────────────────────────────────────────

/**
 * One stage's evidence for a single contact (CAR-246).
 *
 * `count` is deliberately NOT uniform across stages. The email states
 * (contacted / replied / bounced) are per-person and so are 0 or 1 here, because
 * a thread with five follow-ups is one relationship, not five events. The call
 * and referral states count the events themselves, so a single call with two
 * attendees contributes 1 to each of them and the company chip reads
 * "2 Calls Done" — which is the number of conversations that actually happened.
 */
export interface StageTally {
  count: number;
  /**
   * Latest occurrence, EXCEPT `call_scheduled`, which carries the soonest: a
   * chip about an upcoming call should count down to the next one, not report
   * the furthest-out one on the calendar. Null when the row carries no usable
   * date, which drops the time clause rather than inventing one.
   */
  at: string | null;
}

/**
 * Where a contact's reply conversation actually stands (CAR-253).
 *
 * Stage `replied` is sticky — it stays true forever once someone has written
 * back once — so it cannot answer "is there anything for me to do here?". This
 * can: it is computed PER THREAD, because whether we owe a response is a fact
 * about a conversation, not about a person.
 */
export interface ReplyThreadState {
  /**
   * True while no message of ours is dated after their FIRST reply on some
   * thread. Deliberately "first", not "latest": once we have answered, a later
   * reply from them does not restore the write-back prompt — the exchange is
   * live and the card should stop issuing instructions about it.
   *
   * ANY unanswered thread sets this. Two conversations with one still owed a
   * response is still a conversation owed a response.
   */
  awaitingOurReply: boolean;
  /** Latest message on those threads, either direction — what "(2 days ago)" counts from. */
  lastMessageAt: string | null;
}

export interface ContactStage {
  stage: OutreachStage;
  rank: number;
  /**
   * Per-stage evidence, summed across a company's current employees to build
   * the list chip. Every stage is present so the caller can read the winning
   * one without a null check; unreached stages are `{ count: 0, at: null }`.
   */
  tallies: Record<OutreachStage, StageTally>;
  /**
   * Null unless a real inbound reply backs the stage. A `stage_override` of
   * "replied" therefore lands here as null rather than as a claim about a
   * thread that does not exist, and callers fall back to copy that asserts
   * nothing about who wrote last.
   */
  replyThread: ReplyThreadState | null;
}

/** A zeroed tally set — every stage present, nothing claimed. */
function emptyTallies(): Record<OutreachStage, StageTally> {
  return STAGE_ORDER.reduce(
    (acc, stage) => {
      acc[stage] = { count: 0, at: null };
      return acc;
    },
    {} as Record<OutreachStage, StageTally>,
  );
}

/** Later of two ISO timestamps, tolerating nulls on either side. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Earlier of two ISO timestamps, tolerating nulls on either side. */
function earlierOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Batch-derive outreach stages for a set of contacts. ~6 queries total
 * regardless of contact count.
 */
export async function getContactStages(
  userId: string,
  contacts: Array<{ id: number; stage_override?: string | null }>,
): Promise<Map<number, ContactStage>> {
  const result = new Map<number, ContactStage>();
  if (contacts.length === 0) return result;
  const ids = contacts.map((c) => c.id);
  const nowIso = new Date().toISOString();

  const [emails, contactAddrs, interactions, referrals, bounces, calEvents, calLinks, meetingLinks] = await Promise.all([
    chunked(ids, async (chunk) =>
      // Junction-scoped (CAR-159), mirroring the calendar_event_contacts leg
      // below: a shared thread contributes signals to EVERY linked contact,
      // not just the single matched_contact_id. from_address is selected so the
      // aggregation can credit an inbound REPLY only to its actual sender, not
      // to cc'd co-recipients (see the aggregation loop). Paginated: the
      // junction returns one row per (message, contact) link, so a 200-contact
      // chunk of a heavy emailer can exceed PostgREST's 1000-row cap.
      //
      // must() per page (CAR-158), matching every other leg here: a dropped
      // page is indistinguishable from "this contact has no email signal", and
      // deriveStage would then compute an earlier stage from partial evidence,
      // putting an already-contacted person back into outreach queues.
      //
      // thread_id + email_message_id (CAR-253): "have we written back?" is a
      // question about a CONVERSATION, so the aggregation buckets by thread.
      // The junction id is only the bucket key for a message whose thread_id is
      // null, which keeps such a message from merging with unrelated ones.
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("email_message_contacts")
            .select(
              "contact_id, email_message_id, email_messages!inner(user_id, direction, date, from_address, is_simulated, thread_id)",
            )
            .eq("email_messages.user_id", userId)
            .eq("email_messages.is_simulated", false)
            .in("contact_id", chunk)
            .order("email_message_id")
            .order("contact_id")
            .range(from, to),
        ) ?? [],
      ),
    ),
    chunked(ids, async (chunk) =>
      // Contact address sets (CAR-159): used to attribute an inbound reply to
      // the contact who actually sent it. Explicitly user-scoped via the
      // contacts!inner embed (safe under the MCP service-role client).
      //
      // must() (CAR-158): an empty address set silently fails the sender gate
      // below, so a dropped read would stop EVERY inbound reply from crediting
      // its contact — the same "never reaches replied" failure the gate itself
      // is designed to avoid.
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("contact_emails")
            .select("contact_id, email, contacts!inner()")
            .eq("contacts.user_id", userId)
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ) ?? [],
      ),
    ),
    // Every leg below paginates inside its chunk, matching the two legs above
    // and `buildLastTouchMap` in src/lib/data/follow-ups.ts, which carries the
    // same comment for the same reason. `chunked` bounds the URL at 200 ids; it
    // does NOT bound the RESPONSE, and 200 contacts routinely carry more than
    // 1000 rows between them. PostgREST truncates there silently, and these
    // legs are pure Set membership, so a dropped row does not degrade a stage,
    // it INVERTS one: the contact reads `not_contacted` and goes back into
    // outreach queues. `hasOutboundEmail || hasInteraction` means the paginated
    // email leg rescues anyone emailed, so the loss landed precisely on the
    // people whose only evidence is a non-email touch (a LinkedIn DM, a call, a
    // coffee) — exactly the population this leg exists to protect.
    // Measured before fixing: 200 contacts x 6 interactions returned 1000 rows
    // covering 168 of them, so 32 were reported as never contacted.
    chunked(ids, async (chunk) => {
      // Explicitly user-scoped (CAR-151): this also runs under the MCP
      // service-role client, where RLS doesn't filter foreign interactions.
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              // interaction_date (CAR-246): a "Contacted" chip has to say how
              // long ago, and a LinkedIn DM or a coffee is often the only touch
              // a contact has — the email leg cannot date those.
              .from("interactions")
              .select("contact_id, interaction_date, contacts!inner()")
              .eq("contacts.user_id", userId)
              .in("contact_id", chunk)
              .order("id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              // The embedded meeting is the ONLY date a referral has (CAR-246):
              // the table carries no created_at of its own. A referral with no
              // linked meeting renders count-only, by design.
              .from("referrals")
              .select("referred_by_contact_id, meetings(meeting_date)")
              .eq("user_id", userId)
              .in("referred_by_contact_id", chunk)
              .order("id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      // Explicitly user-scoped (CAR-151), same reason as the interactions leg.
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              .from("contact_emails")
              // bounced_at was filtered on but never selected; the chip needs
              // the value to date a "Bounced" state (CAR-246).
              .select("contact_id, bounced_at, contacts!inner()")
              .eq("contacts.user_id", userId)
              .not("bounced_at", "is", null)
              .in("contact_id", chunk)
              .order("id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              .from("calendar_events")
              // `id` (CAR-246) so the two calendar legs can be deduped before
              // counting — see the noteEvent aggregation below.
              .select("id, contact_id, start_at, status")
              .eq("user_id", userId)
              .in("contact_id", chunk)
              .order("id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      // No `id` column: (calendar_event_id, contact_id) is the composite PK, so
      // that pair is the stable pagination order. Ordering by a column this
      // table does not have would 400 rather than fail quietly.
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              .from("calendar_event_contacts")
              // calendar_event_id (CAR-246): the same event reaches a contact
              // through this junction AND through calendar_events.contact_id, so
              // counting without the id double-counts one call.
              .select("calendar_event_id, contact_id, calendar_events!inner(user_id, start_at, status)")
              .eq("calendar_events.user_id", userId)
              .in("contact_id", chunk)
              .order("calendar_event_id")
              .order("contact_id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
    chunked(ids, async (chunk) => {
      // Same composite-key situation as calendar_event_contacts above.
      return (
        (await paginateAll(async (from, to) =>
          must(
            await db()
              .from("meeting_contacts")
              // meeting_id (CAR-246): same dedupe need as the calendar legs.
              .select("meeting_id, contact_id, meetings!inner(user_id, meeting_date)")
              .eq("meetings.user_id", userId)
              .in("contact_id", chunk)
              .order("meeting_id")
              .order("contact_id")
              .range(from, to),
          ),
        )) ?? []
      );
    }),
  ]);

  // Contact -> normalized address set, for inbound sender attribution.
  const addrByContact = new Map<number, Set<string>>();
  for (const r of contactAddrs as Array<{ contact_id: number; email: string | null }>) {
    if (!r.email) continue;
    const set = addrByContact.get(r.contact_id) ?? new Set<string>();
    set.add(r.email.toLowerCase()); // contact_emails.email is already lower(trim())'d
    addrByContact.set(r.contact_id, set);
  }

  // Aggregate signals per contact
  /** Any outbound at all, dated or not — this is what "we reached out" means. */
  const outboundContacts = new Set<number>();
  const firstOutboundAt = new Map<number, string>(); // earliest DATED outbound
  const lastOutboundAt = new Map<number, string>(); // latest DATED outbound (chip recency)
  const inboundAt = new Map<number, string[]>();
  /**
   * The same dated messages, bucketed per contact per thread (CAR-253), which
   * is the only grouping that can answer "did we write back on that thread".
   * Undated messages are skipped here for the same reason the reply gate above
   * ignores them: nothing can be ordered against a date we do not have.
   */
  type ThreadBucket = { lastOutAt: string | null; theirReplyAts: string[]; lastMessageAt: string | null };
  const threadsByContact = new Map<number, Map<string, ThreadBucket>>();
  const threadBucket = (contactId: number, key: string): ThreadBucket => {
    const byThread = threadsByContact.get(contactId) ?? new Map<string, ThreadBucket>();
    threadsByContact.set(contactId, byThread);
    const bucket = byThread.get(key) ?? { lastOutAt: null, theirReplyAts: [], lastMessageAt: null };
    byThread.set(key, bucket);
    return bucket;
  };
  for (const link of emails as Array<{
    contact_id: number;
    email_message_id: number | null;
    email_messages: { direction: string | null; date: string | null; from_address: string | null; thread_id: string | null } | null;
  }>) {
    const m = link.email_messages;
    if (m == null) continue;
    // A message with no thread_id gets a bucket of its own rather than sharing
    // one with every other thread-less message: merging them would let an
    // unrelated later send read as a reply to this conversation.
    const threadKey = m.thread_id ?? `msg:${link.email_message_id}`;
    if (m.direction === "outbound") {
      // Outbound credits every linked contact — they all received the outreach.
      //
      // Existence and dates are tracked separately because a message whose Date
      // header did not parse still proves we reached out, but must never act as
      // the "earliest outbound" the reply gate compares against: it used to be
      // stored as "", which every real inbound timestamp trivially clears, so
      // one undated outbound could report an inbound that PREDATED our outreach
      // as a reply to it.
      outboundContacts.add(link.contact_id);
      if (m.date) {
        const prevFirst = firstOutboundAt.get(link.contact_id);
        if (!prevFirst || m.date < prevFirst) firstOutboundAt.set(link.contact_id, m.date);
        const prevLast = lastOutboundAt.get(link.contact_id);
        if (!prevLast || m.date > prevLast) lastOutboundAt.set(link.contact_id, m.date);
        const bucket = threadBucket(link.contact_id, threadKey);
        bucket.lastOutAt = laterOf(bucket.lastOutAt, m.date);
        bucket.lastMessageAt = laterOf(bucket.lastMessageAt, m.date);
      }
    } else if (m.direction === "inbound") {
      // Inbound counts as a REPLY only for the contact who sent it (their
      // address is from_address), not for cc'd co-recipients who merely
      // received it. Without this, a reply-all on a shared thread would flip
      // every linked contact to stage "replied" and silence their follow-ups
      // (CAR-159 review F9). A message whose sender matches no linked contact
      // address (rare: sender address removed from the contact) is skipped.
      const from = (m.from_address ?? "").toLowerCase();
      if (from && addrByContact.get(link.contact_id)?.has(from) && m.date) {
        const list = inboundAt.get(link.contact_id) ?? [];
        list.push(m.date);
        inboundAt.set(link.contact_id, list);
        const bucket = threadBucket(link.contact_id, threadKey);
        bucket.theirReplyAts.push(m.date);
        bucket.lastMessageAt = laterOf(bucket.lastMessageAt, m.date);
      }
    }
  }

  const interacted = new Set<number>();
  const lastInteractionAt = new Map<number, string>();
  for (const r of interactions as Array<{ contact_id: number; interaction_date: string | null }>) {
    interacted.add(r.contact_id);
    if (!r.interaction_date) continue;
    const prev = lastInteractionAt.get(r.contact_id);
    if (!prev || r.interaction_date > prev) lastInteractionAt.set(r.contact_id, r.interaction_date);
  }

  const referralCount = new Map<number, number>();
  const lastReferralAt = new Map<number, string>();
  for (const r of referrals as Array<{
    referred_by_contact_id: number;
    meetings: { meeting_date: string | null } | null;
  }>) {
    referralCount.set(r.referred_by_contact_id, (referralCount.get(r.referred_by_contact_id) ?? 0) + 1);
    const at = r.meetings?.meeting_date;
    if (!at) continue;
    const prev = lastReferralAt.get(r.referred_by_contact_id);
    if (!prev || at > prev) lastReferralAt.set(r.referred_by_contact_id, at);
  }

  const bounced = new Set<number>();
  const lastBounceAt = new Map<number, string>();
  for (const r of bounces as Array<{ contact_id: number; bounced_at: string | null }>) {
    bounced.add(r.contact_id);
    if (!r.bounced_at) continue;
    const prev = lastBounceAt.get(r.contact_id);
    if (!prev || r.bounced_at > prev) lastBounceAt.set(r.contact_id, r.bounced_at);
  }

  /**
   * Calls per contact, keyed by event so the two calendar legs cannot count the
   * same conversation twice (CAR-246). A calendar event reaches a contact both
   * through `calendar_events.contact_id` and through the
   * `calendar_event_contacts` junction; when these were membership Sets the
   * duplicate collapsed silently, but a COUNT would have reported one call as
   * two. Meetings share the map under their own key prefix.
   */
  const callsByContact = new Map<number, Map<string, string>>();
  const noteEvent = (contactId: number | null, key: string, startAt: string | null, status: string | null) => {
    if (contactId == null || !startAt || status === "cancelled") return;
    const calls = callsByContact.get(contactId) ?? new Map<string, string>();
    calls.set(key, startAt);
    callsByContact.set(contactId, calls);
  };
  for (const e of calEvents) {
    noteEvent(e.contact_id, `cal:${e.id}`, e.start_at, e.status);
  }
  for (const l of calLinks) {
    noteEvent(l.contact_id, `cal:${l.calendar_event_id}`, l.calendar_events?.start_at ?? null, l.calendar_events?.status ?? null);
  }
  for (const l of meetingLinks) {
    // meetings carry no status column, so any dated meeting counts.
    noteEvent(l.contact_id, `mtg:${l.meeting_id}`, l.meetings?.meeting_date ?? null, null);
  }

  for (const contact of contacts) {
    const hasOutbound = outboundContacts.has(contact.id);
    const firstOutbound = firstOutboundAt.get(contact.id) ?? null;
    const inbounds = inboundAt.get(contact.id) ?? [];
    // A reply is inbound mail from them that followed our outreach. When every
    // outbound we hold is undated we cannot order the two, so an inbound from a
    // thread we are demonstrably in still counts — the alternative would drop a
    // real reply on a date-header technicality.
    const replies = firstOutbound
      ? inbounds.filter((d) => d >= firstOutbound)
      : hasOutbound
        ? inbounds
        : [];

    let upcomingCalls = 0;
    let pastCalls = 0;
    let soonestCall: string | null = null;
    let latestCall: string | null = null;
    for (const at of callsByContact.get(contact.id)?.values() ?? []) {
      if (at > nowIso) {
        upcomingCalls++;
        soonestCall = earlierOf(soonestCall, at);
      } else {
        pastCalls++;
        latestCall = laterOf(latestCall, at);
      }
    }

    // Where those replies leave us, per thread (CAR-253). The qualification
    // repeats the rule above rather than reusing `replies`, because the answer
    // is per-conversation: a reply that predates our outreach is not a reply on
    // ANY thread, and a thread holding only such messages must not contribute a
    // "you owe them a response".
    let replyThread: ReplyThreadState | null = null;
    if (replies.length > 0) {
      let awaitingOurReply = false;
      let lastMessageAt: string | null = null;
      for (const bucket of threadsByContact.get(contact.id)?.values() ?? []) {
        const theirs = firstOutbound
          ? bucket.theirReplyAts.filter((d) => d >= firstOutbound)
          : bucket.theirReplyAts;
        if (theirs.length === 0) continue;
        const firstReplyAt = theirs.reduce((a, b) => (a < b ? a : b));
        // Compared against their FIRST reply, so answering once retires the
        // prompt for good: their replying again afterwards is a live exchange,
        // not an outstanding task.
        if (!bucket.lastOutAt || bucket.lastOutAt <= firstReplyAt) awaitingOurReply = true;
        lastMessageAt = laterOf(lastMessageAt, bucket.lastMessageAt);
      }
      replyThread = { awaitingOurReply, lastMessageAt };
    }

    const referrals = referralCount.get(contact.id) ?? 0;
    const interactedHere = interacted.has(contact.id);
    const signals: StageSignals = {
      stageOverride: contact.stage_override ?? null,
      hasReferral: referrals > 0,
      hasPastCall: pastCalls > 0,
      hasUpcomingCall: upcomingCalls > 0,
      hasReply: replies.length > 0,
      hasOutboundEmail: hasOutbound,
      hasInteraction: interactedHere,
      hasBouncedEmail: bounced.has(contact.id),
    };
    const stage = deriveOutreachStage(signals);

    // Evidence for the company chip (CAR-246). Per-person states are capped at
    // 1 so summing across a company counts PEOPLE; call and referral states
    // carry their real event counts so summing counts CONVERSATIONS.
    const tallies = emptyTallies();
    if (hasOutbound || interactedHere) {
      tallies.contacted = {
        count: 1,
        at: laterOf(lastOutboundAt.get(contact.id) ?? null, lastInteractionAt.get(contact.id) ?? null),
      };
    }
    if (replies.length > 0) {
      tallies.replied = { count: 1, at: replies.reduce<string | null>(laterOf, null) };
    }
    if (bounced.has(contact.id)) {
      tallies.bounced = { count: 1, at: lastBounceAt.get(contact.id) ?? null };
    }
    if (upcomingCalls > 0) tallies.call_scheduled = { count: upcomingCalls, at: soonestCall };
    if (pastCalls > 0) tallies.call_done = { count: pastCalls, at: latestCall };
    if (referrals > 0) tallies.referral = { count: referrals, at: lastReferralAt.get(contact.id) ?? null };

    result.set(contact.id, { stage, rank: stageRank(stage), tallies, replyThread });
  }
  return result;
}

// ── Companies dashboard ────────────────────────────────────────────────

export interface TargetInfo {
  id: number;
  priority_score: number | null;
  tier: string | null;
  program_name: string | null;
  app_window_text: string | null;
  next_app_date: string | null;
  status: string;
}

export interface OfficeScopeSummary {
  location_id: number;
  label: string;
  status: string;
}

/**
 * What getCompanies returns WITHOUT the who-you-know enrichment pass
 * (`enrich: false`).
 *
 * The five enrichment fields are absent from this type AND from the object at
 * runtime, so `"alum_count" in summary` is false and reading `.alum_count` is a
 * compile error rather than a plausible-looking `0`. An unenriched summary is
 * therefore structurally distinguishable from an enriched one, which is what
 * stops "nobody at this company went to your school" from being manufactured by
 * a caller that simply opted out of asking.
 */
export interface CompanyBaseSummary {
  id: number;
  name: string;
  logo_url: string | null;
  linkedin_url: string | null;
  current_count: number;
  former_count: number;
  bench_count: number;
  target: TargetInfo | null;
  /** Targeted office scopes (location-level targets), highest priority first. */
  office_scopes: OfficeScopeSummary[];
}

/**
 * The lead contact's OWN history, for the next-action line (CAR-253).
 *
 * Separate from `traction_detail`, which is summed across everyone at the
 * company for the chip. The line names one person, so the clause dating it has
 * to come from that person: "Waiting on Julian. You reached out 3 days ago"
 * must be Julian's outreach, not the most recent of three people's.
 *
 * Null when there is no lead with momentum — a warm-intro lead has no history
 * to report, which is what makes them a warm intro.
 */
export interface LeadDetail {
  /** Latest outreach to the lead: email or logged interaction, whichever is later. */
  last_outreach_at: string | null;
  /** Their reply conversation's state; null when no real inbound backs the stage. */
  reply: ReplyThreadState | null;
}

/** The seven fields the who-you-know pass computes; see CompanyBaseSummary. */
export interface CompanyEnrichment {
  /** BYU alumni among current non-bench contacts — the app's warm-intro edge. */
  alum_count: number;
  /** BYU alumni among current non-bench contacts who are in a product role — the top intro for a PM search. */
  product_alum_count: number;
  /** Recruiters among current non-bench contacts. */
  recruiter_count: number;
  /**
   * The person to name in the next-action line: the highest-traction current
   * contact when there's momentum, else the best warm lead (alum first). Null
   * when the company has no current non-bench contacts.
   */
  lead_contact_name: string | null;
  /** Max derived stage across CURRENT non-bench contacts (pursuing/in_play views). */
  traction: OutreachStage | null;
  /**
   * How much of `traction` there is and when it last happened, for the list
   * chip: "2 Calls Done (2 weeks ago)" (CAR-246). Null whenever `traction` is.
   *
   * `count` can be 0 with a non-null `traction`: `contacts.stage_override` wins
   * over every derived signal, so a company can sit at "Replied" with no inbound
   * message behind it. The chip renders the bare label there rather than
   * asserting a number the data does not support.
   */
  traction_detail: { count: number; at: string | null } | null;
  /** `lead_contact_name`'s own history, dating the next-action line (CAR-253). */
  lead_detail: LeadDetail | null;
}

/**
 * The default getCompanies row: base fields plus the enrichment pass.
 *
 * Deliberately still a single flat shape with exactly the members it had before
 * the split, so every existing consumer and every hand-built test fixture keeps
 * compiling untouched.
 */
export interface CompanySummary extends CompanyBaseSummary, CompanyEnrichment {}

/** One target_companies row (any scope, targeted or not) for derivation. */
export interface CompanyTargetScopeRow {
  id: number;
  location_id: number | null;
  is_targeted: boolean;
  priority_score: number | null;
  tier: string | null;
  program_name: string | null;
  app_window_text: string | null;
  next_app_date: string | null;
  status: string;
  location_label: string | null;
}

/**
 * Collapse a company's scope rows into what the dashboard card shows.
 *
 * The status chip follows the company-wide row when it's targeted, else
 * the highest-priority targeted office. Tier / program / window hint are
 * employer attributes (§18.12 Q5 Option C), so they come from the
 * company-wide row even when it's a soft-untargeted container. The app
 * date is the nearest across targeted scopes (deadlines drive action);
 * priority is the max, so list sorting sees the strongest scope.
 */
export function deriveCompanyTarget(rows: CompanyTargetScopeRow[]): {
  target: TargetInfo | null;
  office_scopes: OfficeScopeSummary[];
} {
  const companyWide = rows.find((r) => r.location_id == null) ?? null;
  const targetedOffices = rows
    .filter((r) => r.location_id != null && r.is_targeted)
    .sort(
      (a, b) =>
        (b.priority_score ?? -1) - (a.priority_score ?? -1) ||
        (a.location_label ?? "").localeCompare(b.location_label ?? ""),
    );

  const office_scopes: OfficeScopeSummary[] = targetedOffices.map((r) => ({
    location_id: r.location_id!,
    label: r.location_label ?? `Location ${r.location_id}`,
    status: r.status,
  }));

  const primary = companyWide?.is_targeted ? companyWide : targetedOffices[0] ?? null;
  if (!primary) return { target: null, office_scopes: [] };

  const targetedScopes = [
    ...(companyWide?.is_targeted ? [companyWide] : []),
    ...targetedOffices,
  ];
  const appDates = targetedScopes
    .map((r) => r.next_app_date)
    .filter((d): d is string => d != null)
    .sort();
  const priorities = targetedScopes
    .map((r) => r.priority_score)
    .filter((p): p is number => p != null);

  return {
    target: {
      id: primary.id,
      status: primary.status,
      tier: companyWide?.tier ?? primary.tier ?? null,
      program_name: companyWide?.program_name ?? primary.program_name ?? null,
      app_window_text: companyWide?.app_window_text ?? primary.app_window_text ?? null,
      next_app_date: appDates[0] ?? null,
      priority_score: priorities.length > 0 ? Math.max(...priorities) : null,
    },
    office_scopes,
  };
}

export type CompanySort = "next" | "priority" | "traction" | "next_app_date" | "name";

/**
 * The sorts an unenriched call may ask for.
 *
 * `next` ranks through nextActionForCompany, which reads all five enrichment
 * fields, and `traction` reads the stage directly — neither is derivable from a
 * CompanyBaseSummary. Excluding them here is what makes the bad combination a
 * compile error at the call site instead of an ordering computed from nothing.
 */
export type UnenrichedCompanySort = Exclude<CompanySort, "next" | "traction">;

/**
 * Which companies the dashboard returns:
 * - `targets`  — only companies the user explicitly targets (outreach queue, MCP).
 * - `pursuing` — targets + companies where the user has a CURRENT *prospect*
 *                contact (someone intentionally put in the outreach funnel).
 *                The primary /companies view: everything you're actually
 *                working, without the noise of every imported contact's employer.
 * - `in_play`  — targets + companies where the user has ANY current non-bench
 *                contact (active or prospect). Broader; retained for callers
 *                that want the full "where I know someone" set.
 * - `all`      — every company with contacts (full network-history search).
 */
export type CompanyScope = "targets" | "pursuing" | "in_play" | "all";

/**
 * Pick which company ids a scope surfaces, given the user's targets and the
 * per-company current/former contact aggregate. Pure so the view semantics
 * are unit-testable without a database.
 *
 * - `targets`  — exactly the targeted companies.
 * - `pursuing` — targets ∪ companies with a CURRENT *prospect* contact.
 *                Intentional signals only: a prospect is someone you moved
 *                into the outreach funnel, so an imported `active` contact
 *                never drags its employer onto the list.
 * - `in_play`  — targets ∪ companies with ANY current contact (active or
 *                prospect). Current only, so a contact's past employers don't
 *                flood the list; bench is already excluded from `current`.
 * - `all`      — targets ∪ companies with ≥ `minContacts` current-or-former
 *                contacts.
 */
export function selectCompanyIds<
  A extends { current: { size: number }; former: { size: number }; currentProspect: { size: number } },
>(
  scope: CompanyScope,
  targetCompanyIds: Iterable<number>,
  aggByCompany: Map<number, A>,
  minContacts = 1,
): number[] {
  if (scope === "targets") return [...new Set(targetCompanyIds)];
  const ids = new Set<number>(targetCompanyIds);
  for (const [id, agg] of aggByCompany) {
    const qualifies =
      scope === "pursuing"
        ? agg.currentProspect.size >= 1
        : scope === "in_play"
          ? agg.current.size >= 1
          : agg.current.size + agg.former.size >= minContacts;
    if (qualifies) ids.add(id);
  }
  return [...ids];
}

interface EmploymentAggRow {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  contacts: {
    name: string;
    network_status: string;
    stage_override: string | null;
    persona: string | null;
    verified_school: string | null;
  };
}

/** One row per company from the company_network_counts RPC (CAR-229). */
interface CompanyCountsRow {
  company_id: number;
  current_count: number;
  former_count: number;
  bench_count: number;
  current_prospect_count: number;
}

/**
 * Per-company contact counts, aggregated in Postgres (CAR-229).
 *
 * This replaces a client-side sweep of EVERY contact_companies row for the
 * user: 17,628 rows over 18 sequential 1,000-row pages on the reference
 * account, 6.6s before anything rendered, growing linearly with the network.
 *
 * The scope filter is pushed into the RPC because it is what bounds the
 * response (7,328 companies unfiltered vs 657 for the `/companies` default).
 * `targetCompanyIds` are always included: a target is shown regardless of how
 * many contacts you have there, so it still needs its counts.
 */
async function fetchCompanyCounts(
  userId: string,
  scope: CompanyScope,
  minContacts: number,
  targetCompanyIds: number[],
): Promise<CompanyCountsRow[]> {
  // Paginated, because a function result is still a PostgREST response and is
  // still cut at max_rows (1000) with error: null. The `all` scope returns
  // 4,708 companies on the reference account, so an unpaginated read silently
  // lost most of them — and getCompanies applies its name search AFTER this,
  // so the search could not find a company outside the arbitrary window. The
  // sweep this replaced did page, so skipping it here was a regression; the
  // parity test caught it (CAR-229).
  //
  // Each page re-runs the aggregate, so this is only cheap because the ordinary
  // scopes fit in one page (in_play 657, pursuing 653, targets ~327). The `all`
  // scope pays a handful of pages and is still far below the 17,628-row sweep
  // it replaced. The function's ORDER BY company_id is what makes the range
  // windows stable.
  return await paginateAll<CompanyCountsRow>(async (from, to) => {
    const { data, error } = await db()
      .rpc("company_network_counts", {
        // Passed explicitly rather than left to auth.uid(): the MCP server
        // injects the service-role client into these modules, where auth.uid()
        // is NULL and RLS is bypassed, so this argument is what scopes the read
        // (src/mcp/lib/db.ts). Omitting it made every MCP company query return
        // zero rows silently — db-scoping.test.ts caught it (CAR-229).
        p_user_id: userId,
        p_scope: scope,
        p_min_contacts: minContacts,
        p_extra_company_ids: targetCompanyIds,
      })
      .order("company_id")
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as CompanyCountsRow[];
  });
}

/**
 * Employment rows for the companies actually being shown (CAR-229).
 *
 * Only the enrichment pass (alumni/recruiter counts, traction, lead name)
 * needs per-person rows, and it only ever looks at the selected companies, so
 * this is bounded by the view rather than by the size of the whole network.
 *
 * chunkedPaginated, not chunked: contact_companies fans out (several people
 * per company, several roles per person), so a single id chunk can exceed
 * PostgREST's 1000-row cap and truncate silently. The explicit .order() is
 * required by paginateAll's contract and was missing from the sweep this
 * replaces, where range windows over an unspecified order could duplicate or
 * drop rows at page boundaries.
 */
async function fetchEmploymentRowsForCompanies(
  userId: string,
  companyIds: number[],
): Promise<EmploymentAggRow[]> {
  return await chunkedPaginated<EmploymentAggRow>(companyIds, async (chunk, from, to) =>
    must(
      await db()
        .from("contact_companies")
        .select(
          "company_id, contact_id, is_current, contacts!inner(user_id, name, network_status, stage_override, persona, verified_school)",
        )
        .eq("contacts.user_id", userId)
        .in("company_id", chunk)
        .order("company_id")
        .order("contact_id")
        .order("id")
        .range(from, to),
    ),
  );
}

interface GetCompaniesCommonOptions {
  scope?: CompanyScope;
  search?: string;
  minContacts?: number;
}

/** The default call: the who-you-know pass runs and every field is a real value. */
export interface GetCompaniesEnrichedOptions extends GetCompaniesCommonOptions {
  sort?: CompanySort;
  /** Omit (or pass true) to run the enrichment pass. */
  enrich?: true;
}

/**
 * Opt out of the who-you-know pass.
 *
 * `sort` is REQUIRED here and narrowed to the orders that do not read the
 * enrichment: leaving it to the default would pick `next` for the
 * pursuing/in_play scopes, and `next` cannot be computed from what this call
 * returns.
 */
export interface GetCompaniesUnenrichedOptions extends GetCompaniesCommonOptions {
  sort: UnenrichedCompanySort;
  enrich: false;
}

export async function getCompanies(
  userId: string,
  opts?: GetCompaniesEnrichedOptions,
): Promise<CompanySummary[]>;
export async function getCompanies(
  userId: string,
  opts: GetCompaniesUnenrichedOptions,
): Promise<CompanyBaseSummary[]>;
export async function getCompanies(
  userId: string,
  opts: GetCompaniesEnrichedOptions | GetCompaniesUnenrichedOptions = {},
): Promise<CompanyBaseSummary[]> {
  const scope = opts.scope ?? "targets";
  const enrich = opts.enrich ?? true;
  // Default order: focused views lead with what needs you next; the full
  // search is alphabetical; the outreach/MCP targets queue stays priority-first.
  const sort = opts.sort ?? (scope === "all" ? "name" : scope === "targets" ? "priority" : "next");
  // The overloads already make this unreachable from TypeScript. It is here for
  // the callers types cannot see — the MCP tool layer resolves arguments from
  // JSON, and a silently mis-ordered outreach queue is not a failure anyone
  // would notice from the output.
  if (!enrich && (sort === "next" || sort === "traction")) {
    throw new Error(
      `getCompanies: sort "${sort}" reads the who-you-know enrichment. ` +
        `Use enrich:true, or sort by priority / next_app_date / name.`,
    );
  }
  // Whether the pass RUNS, which is not the same question as whether its five
  // fields are emitted. `all` has always skipped the pass while still returning
  // the fields as 0/null, and callers (MCP list_companies) read them that way,
  // so that shape is preserved verbatim; only `enrich: false` drops the keys.
  const runEnrichment = enrich && scope !== "all";

  // All scope rows, including soft-untargeted containers: tier/program
  // live on the company-wide row even when only offices are targeted.
  //
  // Paginated (CAR-223): one row per company AND per targeted office, so the
  // count multiplies well past the company count, and a truncated read here
  // drops companies out of the targets view entirely.
  //
  // It leads the function because the target company ids it yields are an input
  // to the counts aggregate below (CAR-229) — targets are shown whether or not
  // they have contacts — so nothing that reads companyIds can share its wave.
  //
  // What CAN share it is the viewer's school. That read depends on nothing,
  // feeds only the enrichment pass at the bottom, and awaiting it down there put
  // a single-row lookup on the critical path between the employment read and the
  // stage fan-out. It stays CONDITIONAL on whether that pass will run at all —
  // the `all` view and any `enrich: false` caller both discard the value — so
  // neither pays for it.
  const [scopeRows, userSchool] = await Promise.all([
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("target_companies")
          .select(
            "id, company_id, location_id, is_targeted, priority_score, tier, program_name, app_window_text, next_app_date, status, locations(city, state, country)",
          )
          .eq("user_id", userId)
          .order("id")
          .range(from, to),
      ),
    ),
    runEnrichment ? viewerSchool(userId) : Promise.resolve(null),
  ]);
  // A company is a target if ANY scope (company-wide or office) is targeted.
  const targetByCompany = new Map<number, ReturnType<typeof deriveCompanyTarget>>();
  {
    const rowsByCompany = new Map<number, CompanyTargetScopeRow[]>();
    for (const r of scopeRows) {
      const list = rowsByCompany.get(r.company_id) ?? [];
      list.push({ ...r, location_label: locationLabel(r.locations) });
      rowsByCompany.set(r.company_id, list);
    }
    for (const [companyId, rows] of rowsByCompany) {
      const derived = deriveCompanyTarget(rows);
      if (derived.target) targetByCompany.set(companyId, derived);
    }
  }

  // Per-company counts AND the scope selection, both computed in Postgres
  // (CAR-229). Targets ride along as extras so they keep their counts even
  // when they have no contacts yet.
  const countRows = await fetchCompanyCounts(userId, scope, opts.minContacts ?? 1, [...targetByCompany.keys()]);
  const countsByCompany = new Map(countRows.map((r) => [r.company_id, r]));

  // selectCompanyIds stays the authoritative statement of the scope rule even
  // though the RPC has already applied it, and re-applying it in TS is
  // idempotent over a correctly-filtered response.
  //
  // Do NOT read that as "the TS can only narrow the SQL, so drift is safe".
  // It is not a narrowing: selectCompanyIds unconditionally seeds its result
  // with every target id, so it WIDENS. That widening is what masked a real
  // SQL bug (a zero-contact target could not come back through
  // p_extra_company_ids at all) and kept it off the screen, which is exactly
  // why the divergence has to be tested rather than reasoned about.
  // company-scope.test.ts pins the TS rule; company-network-counts.itest.ts
  // drives both halves from one fixture and asserts they agree.
  const companyIds = selectCompanyIds(
    scope,
    targetByCompany.keys(),
    new Map(
      [...countsByCompany].map(([id, r]) => [
        id,
        {
          current: { size: r.current_count },
          former: { size: r.former_count },
          currentProspect: { size: r.current_prospect_count },
        },
      ]),
    ),
    opts.minContacts ?? 1,
  );
  if (companyIds.length === 0) return [];

  // Per-person rows for the shown companies only — the enrichment pass below
  // is the sole consumer, and it never looks past `companyIds`.
  //
  // The company name/logo read runs in the SAME wave (CAR-229): both are keyed
  // on `companyIds` and neither reads the other's rows, so the only thing that
  // used to order them was where they were written. Each is a serial chunk loop
  // over the shown companies, so running them back to back doubled the chunk
  // depth of this stage.
  //
  // Under `enrich: false` the employment read is skipped outright, because the
  // enrichment pass is its only consumer: the counts on the card come from the
  // RPC above, and selectCompanyIds ran off the RPC's rows too. That is the
  // larger half of what the option saves — it is the read that fans companies
  // out to people, and the contact ids it produces are what the stage/alum
  // fan-out then chunks over.
  //
  // Gated on `runEnrichment`, which also covers `scope: "all"`. These rows feed
  // aggByCompany, and aggByCompany is read ONLY inside the enrichment block
  // below — the summaries take their counts from the RPC. So for `all` this was
  // a chunkedPaginated sweep over every selected company's employment rows
  // whose result was then dropped on the floor: ~4,700 companies' worth on the
  // reference account, for MCP's list_companies(targets_only: false). Skipping
  // it cannot change that scope's output, because nothing downstream can
  // observe the difference.
  const [employment, companyRows] = await Promise.all([
    runEnrichment ? fetchEmploymentRowsForCompanies(userId, companyIds) : Promise.resolve([]),
    chunked(companyIds, async (chunk) => {
      let q = db()
        .from("companies")
        .select("id, name, logo_url, linkedin_url")
        .in("id", chunk);
      if (opts.search?.trim()) {
        q = q.ilike("name", `%${escapeIlike(opts.search.trim())}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    }),
  ]);

  // Aggregate people per company; bench counted separately, never mixed
  interface PersonAgg {
    id: number;
    name: string;
    stage_override: string | null;
    persona: string | null;
    verified_school: string | null;
    is_current: boolean;
  }
  interface Agg {
    current: Set<number>;
    former: Set<number>;
    bench: Set<number>;
    /** Current contacts intentionally put in the outreach funnel (network_status='prospect'). */
    currentProspect: Set<number>;
    /** Non-bench people at this company, deduped by contact id (current wins). */
    people: Map<number, PersonAgg>;
  }
  const aggByCompany = new Map<number, Agg>();
  for (const row of employment) {
    let agg = aggByCompany.get(row.company_id);
    if (!agg) {
      agg = {
        current: new Set(),
        former: new Set(),
        bench: new Set(),
        currentProspect: new Set(),
        people: new Map(),
      };
      aggByCompany.set(row.company_id, agg);
    }
    const contact = row.contacts;
    if (contact.network_status === "bench") {
      agg.bench.add(row.contact_id);
    } else {
      (row.is_current ? agg.current : agg.former).add(row.contact_id);
      if (row.is_current && contact.network_status === "prospect") agg.currentProspect.add(row.contact_id);
      const existing = agg.people.get(row.contact_id);
      if (existing) {
        // Same contact, multiple roles at this company — collapse; current wins.
        if (row.is_current) existing.is_current = true;
      } else {
        agg.people.set(row.contact_id, {
          id: row.contact_id,
          name: contact.name,
          stage_override: contact.stage_override,
          persona: contact.persona,
          verified_school: contact.verified_school,
          is_current: row.is_current,
        });
      }
    }
  }
  // A boomeranger is current, not former
  for (const agg of aggByCompany.values()) {
    for (const id of agg.current) agg.former.delete(id);
  }

  // Enrichment (traction + who-you-know) per company. Skipped for the "all"
  // view, whose company set is unbounded (targets/pursuing/in_play are bounded
  // and safe), and for an `enrich: false` caller. One extra batched query (BYU
  // alumni) over the shown set.
  const traction = new Map<number, OutreachStage>();
  const tractionDetail = new Map<number, { count: number; at: string | null }>();
  const alumCountByCompany = new Map<number, number>();
  const productAlumCountByCompany = new Map<number, number>();
  const recruiterCountByCompany = new Map<number, number>();
  const leadNameByCompany = new Map<number, string | null>();
  const leadDetailByCompany = new Map<number, LeadDetail | null>();
  if (runEnrichment) {
    const uniqueContacts = new Map<number, { id: number; stage_override: string | null }>();
    for (const id of companyIds) {
      for (const p of aggByCompany.get(id)?.people.values() ?? []) {
        uniqueContacts.set(p.id, { id: p.id, stage_override: p.stage_override });
      }
    }
    // userSchool was resolved in the first wave, above.
    const [stages, alumByContact] = await Promise.all([
      getContactStages(userId, [...uniqueContacts.values()]),
      alumContactIds([...uniqueContacts.keys()], userSchool),
    ]);
    const isAlum = (p: PersonAgg) =>
      alumByContact.has(p.id) || verifiedSchoolCounts(p.verified_school, userSchool);
    // An alum of your school in a product role — the highest-value intro.
    const isProductAlum = (p: PersonAgg) => isAlum(p) && PRODUCT_PERSONAS.has(p.persona ?? "");

    for (const id of companyIds) {
      const people = [...(aggByCompany.get(id)?.people.values() ?? [])];
      const current = people.filter((p) => p.is_current);
      alumCountByCompany.set(id, current.filter(isAlum).length);
      productAlumCountByCompany.set(id, current.filter(isProductAlum).length);
      recruiterCountByCompany.set(id, current.filter((p) => p.persona === "recruiter").length);

      // Max derived stage, and the contact driving it.
      //
      // CURRENT employees only, because traction is a claim about the company
      // you could still walk into — not about everyone who has ever worked
      // there. Reading it over `people` let a contact who left a decade ago own
      // a company's traction: BambooHR showed "Contacted · Waiting on Preston"
      // off one 2016-era account executive while all ten current employees sat
      // untouched. Worse than the wrong name, `contacted` outranks the
      // warm-intro branch in nextActionForCompany, so the former employee
      // SUPPRESSED the company's real next move (five untouched alumni in
      // product). The three counts above already filter to `current`; this pass
      // was the one that did not (CAR-244).
      //
      // CAR-244 softened this with a fallback to `people` when nobody current
      // remained, so the chip would not blank out. CAR-246 REMOVES that: a
      // company whose contacts have all moved on shows no traction at all,
      // because "2 Calls Done" next to a company where you know nobody is a
      // claim about a door that is already closed. Deliberate reversal, not a
      // regression — do not restore the fallback.
      //
      // The tie-break exists because the winner also NAMES the line (CAR-253).
      // Two current contacts both at `replied` are the same rank, so the first
      // one seen used to win — and if that one's thread is already answered
      // while the other's is not, the card would read "You had an email thread
      // with Samuel" and bury the reply actually waiting on a response. Whoever
      // still owes us nothing loses the tie.
      let best: { stage: ContactStage; person: PersonAgg } | null = null;
      for (const p of current) {
        const s = stages.get(p.id);
        if (!s) continue;
        const wins =
          !best ||
          s.rank > best.stage.rank ||
          (s.rank === best.stage.rank &&
            !!s.replyThread?.awaitingOurReply &&
            !best.stage.replyThread?.awaitingOurReply);
        if (wins) best = { stage: s, person: p };
      }
      if (best) {
        traction.set(id, best.stage.stage);
        // How much of that stage there is, across everyone still working here.
        // Summed over CURRENT contacts, not just the one that won: three people
        // contacted is "3 Contacted" even though one of them set the stage.
        const winning = best.stage.stage;
        let count = 0;
        let at: string | null = null;
        for (const p of current) {
          const tally = stages.get(p.id)?.tallies[winning];
          if (!tally || tally.count === 0) continue;
          count += tally.count;
          // Upcoming calls count DOWN to the next one; everything else reports
          // the most recent thing that happened.
          at = winning === "call_scheduled" ? earlierOf(at, tally.at) : laterOf(at, tally.at);
        }
        tractionDetail.set(id, { count, at });
      }

      // Lead name for the next-action line: the contact with real momentum, else
      // the best warm lead among current contacts (product alum → alum → recruiter → any).
      let lead: string | null = null;
      let leadDetail: LeadDetail | null = null;
      if (best && best.stage.rank > stageRank("not_contacted")) {
        lead = best.person.name;
        // Only the momentum lead carries history worth dating. A warm-intro
        // lead has none by definition, and the fallback below picks them by
        // affinity rather than by anything that happened.
        leadDetail = {
          last_outreach_at: best.stage.tallies.contacted.at,
          reply: best.stage.replyThread,
        };
      } else if (current.length > 0) {
        const warm =
          current.find(isProductAlum) ??
          current.find(isAlum) ??
          current.find((p) => p.persona === "recruiter") ??
          current[0];
        lead = warm.name;
      }
      leadNameByCompany.set(id, lead);
      leadDetailByCompany.set(id, leadDetail);
    }
  }

  /**
   * The two halves every row carries regardless of enrichment, split out so the
   * enriched literal below can keep its exact original member order while the
   * unenriched one simply omits the five keys. Sharing the expressions is what
   * stops the two shapes from drifting on a base field.
   */
  const parts = (c: { id: number; name: string; logo_url: string | null; linkedin_url: string | null }) => {
    const derived = targetByCompany.get(c.id);
    // Counts come from the RPC, not from the in-memory sets: the employment
    // rows are now fetched only for the shown companies, so the sets are an
    // enrichment input rather than a complete tally (CAR-229).
    const counts = countsByCompany.get(c.id);
    return {
      identity: {
        id: c.id,
        name: c.name,
        logo_url: c.logo_url,
        linkedin_url: c.linkedin_url,
        current_count: counts?.current_count ?? 0,
        former_count: counts?.former_count ?? 0,
        bench_count: counts?.bench_count ?? 0,
      },
      scopes: {
        target: derived?.target ?? null,
        office_scopes: derived?.office_scopes ?? [],
      },
    };
  };

  const rows = companyRows as Array<{
    id: number;
    name: string;
    logo_url: string | null;
    linkedin_url: string | null;
  }>;
  // Kept as its own typed binding rather than narrowed back out of `summaries`
  // with a cast: it is the only thing that lets the "next" sort below reach
  // nextActionForCompany, and a cast there would be the one place a caller
  // could still read an uncomputed field.
  const enrichedSummaries: CompanySummary[] | null = enrich
    ? rows.map((c) => {
        const { identity, scopes } = parts(c);
        return {
          ...identity,
          alum_count: alumCountByCompany.get(c.id) ?? 0,
          product_alum_count: productAlumCountByCompany.get(c.id) ?? 0,
          recruiter_count: recruiterCountByCompany.get(c.id) ?? 0,
          lead_contact_name: leadNameByCompany.get(c.id) ?? null,
          ...scopes,
          traction: traction.get(c.id) ?? null,
          traction_detail: tractionDetail.get(c.id) ?? null,
          lead_detail: leadDetailByCompany.get(c.id) ?? null,
        };
      })
    : null;
  const summaries: CompanyBaseSummary[] =
    enrichedSummaries ??
    rows.map((c) => {
      const { identity, scopes } = parts(c);
      return { ...identity, ...scopes };
    });

  const cmpNullsLast = (a: number | string | null, b: number | string | null, desc = false) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (a < b) return desc ? 1 : -1;
    if (a > b) return desc ? -1 : 1;
    return 0;
  };
  // "What's next" ranks are relatively expensive to derive; precompute once.
  // Driven off `enrichedSummaries` rather than `summaries`, so the sort that
  // needs all five enrichment fields can only be computed from rows that
  // actually have them — the guard at the top of the function has already
  // rejected the combination, and this is what stops a cast from re-opening it.
  const nextRank = new Map<number, number>();
  if (sort === "next" && enrichedSummaries) {
    const now = new Date();
    // A company the ladder has nothing to say about still needs a rank, or it
    // would sort as undefined rather than last (CAR-246).
    for (const c of enrichedSummaries) nextRank.set(c.id, nextActionForCompany(c, now)?.rank ?? NO_ACTION_RANK);
  }
  summaries.sort((a, b) => {
    switch (sort) {
      case "next":
        return (
          (nextRank.get(b.id) ?? 0) - (nextRank.get(a.id) ?? 0) ||
          cmpNullsLast(a.target?.next_app_date ?? null, b.target?.next_app_date ?? null) ||
          a.name.localeCompare(b.name)
        );
      case "priority":
        return (
          cmpNullsLast(a.target?.priority_score ?? null, b.target?.priority_score ?? null, true) ||
          a.name.localeCompare(b.name)
        );
      case "next_app_date":
        return (
          cmpNullsLast(a.target?.next_app_date ?? null, b.target?.next_app_date ?? null) ||
          a.name.localeCompare(b.name)
        );
      case "traction": {
        // Read from the map the enrichment pass filled rather than off the row,
        // which is the identical value (`traction: traction.get(c.id) ?? null`)
        // and keeps this comparator typed over CompanyBaseSummary.
        const sa = traction.get(a.id) ?? null;
        const sb = traction.get(b.id) ?? null;
        const ra = sa ? stageRank(sa) : -1;
        const rb = sb ? stageRank(sb) : -1;
        return rb - ra || a.name.localeCompare(b.name);
      }
      default:
        return a.name.localeCompare(b.name);
    }
  });
  return summaries;
}

// ── Company detail ─────────────────────────────────────────────────────

const personaRank = (p: string | null) => {
  const order = ["recruiter", "product_leader", "alum_product", "product_peer", "alum_other"];
  const i = p ? order.indexOf(p) : -1;
  return i === -1 ? order.length : i;
};

/** Contacts-list order: BYU alumni always lead, then persona rank, then name. */
export const byAlumThenPersona = (
  a: Pick<CompanyPerson, "is_alum" | "persona" | "name">,
  b: Pick<CompanyPerson, "is_alum" | "persona" | "name">,
) =>
  Number(b.is_alum) - Number(a.is_alum) ||
  personaRank(a.persona) - personaRank(b.persona) ||
  a.name.localeCompare(b.name);

export interface CompanyPerson {
  contact_id: number;
  name: string;
  photo_url: string | null;
  headline: string | null;
  persona: string | null;
  network_status: string;
  is_alum: boolean;
  review_note: string | null;
  selection_reason: string | null;
  last_scraped_at: string | null;
  linkedin_url: string | null;
  stage: OutreachStage | null;
  email: { address: string; source: string; bounced: boolean } | null;
  /** Most recent logged interaction (offline touchpoints live on the contact). */
  last_interaction: { type: string; date: string } | null;
  adjacency_score: number | null;
  /** Employment rows at this company (all current titles, newest first). */
  roles: Array<{
    id: number;
    title: string | null;
    is_current: boolean;
    start_month: string | null;
    end_month: string | null;
    location_id: number | null;
    location_label: string | null;
    location_city: string | null;
    location_state: string | null;
    location_country: string | null;
    workplace_type: string | null;
  }>;
  /**
   * The contact's current employer (their `contact_companies` row where `is_current`),
   * which may be a different company than the one whose page this is — mirrors the
   * contacts-list card. Null when no current company is on file.
   */
  current_position: { title: string | null; company_id: number; company_name: string } | null;
}

export interface LocationFacet {
  key: string; // location id as string, or 'remote' / 'unknown'
  label: string;
  location_id: number | null;
  count: number;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface CompanyOffice {
  id: number;
  location_id: number;
  source: string;
  label: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface CompanyNote {
  id: number;
  note: string;
  created_at: string;
  location_id: number | null;
  location_label: string | null;
}

export interface CompanyDetail {
  company: { id: number; name: string; logo_url: string | null; linkedin_url: string | null; universal_name: string | null };
  target: (TargetInfo & { notes: CompanyNote[] }) | null;
  offices: CompanyOffice[];
  facets: LocationFacet[];
  current: CompanyPerson[];
  former: CompanyPerson[];
  bench: CompanyPerson[];
}

function locationLabel(loc: { city: string | null; state: string | null; country: string } | null): string | null {
  if (!loc) return null;
  if (loc.city) return [loc.city, loc.state].filter(Boolean).join(", ");
  if (loc.state) return [loc.state, loc.country].filter(Boolean).join(", ");
  return loc.country || null;
}

export async function getCompanyDetail(
  userId: string,
  companyId: number,
): Promise<CompanyDetail | null> {
  // ── Wave 1 ──────────────────────────────────────────────────────────────
  //
  // Five reads, ONE round trip. None of them depends on another: the viewer's
  // school (CAR-213) is consumed only by the alum badge at the very bottom of
  // this function, and the roster read is keyed on `companyId` alone. Awaiting
  // them in the order they were written cost three extra sequential round trips
  // on every company step of the /outreach flow, which is the whole reason this
  // function read as "three sequential waves that scale with employee count"
  // (CAR-229).
  //
  // The roster rides in this wave even though a company the user cannot see
  // makes it wasted work. That path returns null and is rare; paying a round
  // trip to find out on every SUCCESSFUL load is not. Promise.all attaches a
  // handler to every leg as it is constructed, so a rejection in one can never
  // surface as an unhandled rejection while another is still in flight.
  const [detailUserSchool, companyRes, officesRes, targetRes, rows] = await Promise.all([
    viewerSchool(userId),
    db()
      .from("companies")
      .select("id, name, logo_url, linkedin_url, universal_name")
      .eq("id", companyId)
      .maybeSingle(),
    db()
      .from("company_locations")
      .select("id, location_id, source, locations(city, state, country)")
      .eq("company_id", companyId),
    db()
      .from("target_companies")
      .select("id, priority_score, tier, program_name, app_window_text, next_app_date, status")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .is("location_id", null)
      .eq("is_targeted", true)
      .maybeSingle(),
    // Employment rows for this company across the user's contacts.
    //
    // Paginated, and ordered (CAR-207). `.limit(2000)` asked for twice what
    // PostgREST will ever return, so a company with more than 1000 employment
    // rows silently lost the rest — and with no ORDER BY, Postgres guarantees no
    // ordering at all, so WHICH 1000 came back could differ between two loads of
    // the same page. `id` is the stable key range pagination needs.
    paginateAll(async (from, to) => {
      const { data, error } = await db()
        .from("contact_companies")
        .select(
          `id, contact_id, title, is_current, start_month, end_month, location_id, workplace_type,
         locations(city, state, country),
         contacts!inner(id, user_id, name, photo_url, headline, persona, network_status, verified_school, review_note, last_scraped_at, stage_override, import_meta, linkedin_url)`,
        )
        .eq("company_id", companyId)
        .eq("contacts.user_id", userId)
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data;
    }),
  ]);
  if (companyRes.error) throw companyRes.error;
  if (!companyRes.data) return null;

  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const nonBench = new Map<number, { id: number; stage_override: string | null }>();
  for (const r of rows) {
    if (r.contacts.network_status !== "bench") {
      nonBench.set(r.contact_id, { id: r.contact_id, stage_override: r.contacts.stage_override });
    }
  }

  // ── Wave 2 ──────────────────────────────────────────────────────────────
  //
  // Everything downstream of the roster, in ONE round trip.
  //
  // getContactStages belongs HERE, not in a wave of its own after these four.
  // Its only input is the non-bench contact id set, which wave 1 already
  // produced, so the await that used to follow them was ordering, not
  // dependency — one more full round trip on every company step. Its eight legs
  // are internally parallel, so folding it in widens this wave rather than
  // deepening it.
  //
  // Its legs are NOT narrowed for the outreach view. Each one feeds a distinct
  // StageSignals field, and a missing signal does not degrade a stage, it
  // INVERTS one — drop the referrals leg and a referred contact silently reads
  // `contacted`, drop the bounce leg and a dead address reads contactable. The
  // outreach card renders that chip and the queue's traction ordering reads the
  // same derivation, so a narrower leg set would be a correctness regression
  // wearing a performance costume.
  //
  // The target-notes read is here for the same reason: it depends only on the
  // target row wave 1 returned, and running it last put a single-row lookup on
  // the critical path.
  //
  // chunkedPaginated, matching fetchEmploymentRowsForCompanies: every one of
  // these tables fans out (several emails, schools, interactions or past roles
  // per contact), so `chunked` alone would bound the URL and not the response
  // (CAR-223), and `contactIds` is unbounded here.
  const [emailRows, schoolRows, interactionRows, currentPositionRows, stages, noteRows] =
    await Promise.all([
      chunkedPaginated(contactIds, async (chunk, from, to) =>
        must(
          await db()
            .from("contact_emails")
            .select("contact_id, email, source, is_primary, bounced_at")
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ),
      ),
      chunkedPaginated(contactIds, async (chunk, from, to) =>
        must(
          await db()
            .from("contact_schools")
            .select("contact_id, schools(name)")
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ),
      ),
      chunkedPaginated(contactIds, async (chunk, from, to) =>
        must(
          await db()
            .from("interactions")
            .select("contact_id, interaction_type, interaction_type_detail, interaction_date")
            .in("contact_id", chunk)
            // interaction_date DESC stays PRIMARY, with id DESC only as the
            // tiebreaker range pagination needs. The consumer below keeps the
            // first row seen per contact as `last_interaction`, so leading
            // with `id` (the shape every other leg here uses) would silently
            // hand every contact their OLDEST interaction instead of their
            // newest, and nothing on screen would look wrong.
            .order("interaction_date", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        ),
      ),
      chunkedPaginated(contactIds, async (chunk, from, to) =>
        must(
          await db()
            .from("contact_companies")
            .select("contact_id, title, companies(id, name)")
            .eq("is_current", true)
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ),
      ),
      getContactStages(userId, [...nonBench.values()]),
      targetRes.data
        ? (async () =>
            must(
              await db()
                .from("target_company_notes")
                .select("id, note, created_at, location_id, locations(city, state, country)")
                .eq("target_company_id", (targetRes.data as TargetInfo).id)
                .order("created_at", { ascending: false }),
            ))()
        : Promise.resolve(null),
    ]);

  const emailByContact = new Map<number, { address: string; source: string; bounced: boolean }>();
  for (const e of emailRows) {
    if (!e.email) continue;
    const existing = emailByContact.get(e.contact_id);
    if (!existing || e.is_primary) {
      emailByContact.set(e.contact_id, { address: e.email, source: e.source, bounced: e.bounced_at != null });
    }
  }
  const alumContacts = new Set<number>();
  for (const s of schoolRows) {
    if (schoolsMatch(s.schools?.name, detailUserSchool)) alumContacts.add(s.contact_id);
  }

  // Rows arrive newest-first per chunk; keep the first seen per contact.
  const lastInteractionByContact = new Map<number, { type: string; date: string }>();
  for (const i of interactionRows) {
    if (!lastInteractionByContact.has(i.contact_id)) {
      lastInteractionByContact.set(i.contact_id, {
        type: conversationTypeLabel(i.interaction_type, i.interaction_type_detail) ?? i.interaction_type,
        date: i.interaction_date,
      });
    }
  }

  // Current employer per contact (contact_companies.is_current); a contact could
  // theoretically have more than one flagged current — keep the first seen.
  const currentPositionByContact = new Map<number, { title: string | null; company_id: number; company_name: string }>();
  for (const p of currentPositionRows) {
    if (!p.companies || currentPositionByContact.has(p.contact_id)) continue;
    currentPositionByContact.set(p.contact_id, { title: p.title, company_id: p.companies.id, company_name: p.companies.name });
  }

  // Group rows into people
  const peopleById = new Map<number, CompanyPerson>();
  for (const r of rows) {
    let person = peopleById.get(r.contact_id);
    if (!person) {
      const meta = r.contacts.import_meta;
      const adjacency = meta && typeof meta === "object" && "adjacency_score" in meta ? Number(meta.adjacency_score) : NaN;
      person = {
        contact_id: r.contact_id,
        name: r.contacts.name,
        photo_url: r.contacts.photo_url,
        headline: r.contacts.headline,
        persona: r.contacts.persona,
        network_status: r.contacts.network_status,
        is_alum:
          alumContacts.has(r.contact_id) ||
          verifiedSchoolCounts(r.contacts.verified_school, detailUserSchool),
        review_note: r.contacts.review_note,
        selection_reason:
          meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.selection_reason === "string"
            ? meta.selection_reason
            : null,
        last_scraped_at: r.contacts.last_scraped_at,
        linkedin_url: r.contacts.linkedin_url,
        stage: stages.get(r.contact_id)?.stage ?? null,
        email: emailByContact.get(r.contact_id) ?? null,
        last_interaction: lastInteractionByContact.get(r.contact_id) ?? null,
        adjacency_score: Number.isNaN(adjacency) ? null : adjacency,
        roles: [],
        current_position: currentPositionByContact.get(r.contact_id) ?? null,
      };
      peopleById.set(r.contact_id, person);
    }
    person.roles.push({
      id: r.id,
      title: r.title,
      is_current: r.is_current,
      start_month: r.start_month,
      end_month: r.end_month,
      location_id: r.location_id,
      location_label: locationLabel(r.locations),
      location_city: r.locations?.city ?? null,
      location_state: r.locations?.state ?? null,
      location_country: r.locations?.country ?? null,
      workplace_type: r.workplace_type,
    });
  }
  for (const person of peopleById.values()) {
    // CAR-216: the old comparator tiebroke on localeCompare over "Mon YYYY",
    // which orders by month NAME (Mar 2021 above Jul 2021, both above Jul 2014).
    person.roles = sortExperiences(person.roles);
  }

  // Facets over everyone at the company (honest buckets incl. Remote/Unknown)
  const facetCounts = new Map<
    string,
    {
      label: string;
      location_id: number | null;
      city: string | null;
      state: string | null;
      country: string | null;
      contacts: Set<number>;
    }
  >();
  for (const r of rows) {
    let key: string;
    let label: string;
    let locId: number | null = null;
    let city: string | null = null;
    let state: string | null = null;
    let country: string | null = null;
    if (r.workplace_type === "remote") {
      key = "remote";
      label = "Remote";
    } else if (r.location_id != null) {
      key = String(r.location_id);
      label = locationLabel(r.locations) ?? `Location ${r.location_id}`;
      locId = r.location_id;
      city = r.locations?.city ?? null;
      state = r.locations?.state ?? null;
      country = r.locations?.country ?? null;
    } else {
      key = "unknown";
      label = "Unknown";
    }
    let f = facetCounts.get(key);
    if (!f) {
      f = { label, location_id: locId, city, state, country, contacts: new Set() };
      facetCounts.set(key, f);
    }
    f.contacts.add(r.contact_id);
  }
  const facets: LocationFacet[] = [...facetCounts.entries()]
    .map(([key, f]) => ({
      key,
      label: f.label,
      location_id: f.location_id,
      count: f.contacts.size,
      city: f.city,
      state: f.state,
      country: f.country,
    }))
    .sort((a, b) => {
      // Real locations first (by count desc), then Remote, then Unknown
      const special = (k: string) => (k === "unknown" ? 2 : k === "remote" ? 1 : 0);
      return special(a.key) - special(b.key) || b.count - a.count || a.label.localeCompare(b.label);
    });

  const isCurrent = new Set(rows.filter((r) => r.is_current).map((r) => r.contact_id));

  const current: CompanyPerson[] = [];
  const former: CompanyPerson[] = [];
  const bench: CompanyPerson[] = [];
  for (const person of peopleById.values()) {
    if (person.network_status === "bench") {
      bench.push(person);
    } else if (isCurrent.has(person.contact_id)) {
      current.push(person);
    } else {
      former.push(person);
    }
  }
  current.sort(byAlumThenPersona);
  former.sort(byAlumThenPersona);
  // Bench: the pipeline's own ranking (adjacency), best first
  bench.sort((a, b) => (b.adjacency_score ?? -1) - (a.adjacency_score ?? -1) || a.name.localeCompare(b.name));

  // Target notes (read in wave 2 above, assembled here).
  let target: CompanyDetail["target"] = null;
  if (targetRes.data) {
    const t = targetRes.data as TargetInfo;
    const notes: CompanyNote[] = ((noteRows) ?? [])
      .map((n) => ({
        id: n.id,
        note: n.note,
        created_at: n.created_at,
        location_id: n.location_id,
        location_label: locationLabel(n.locations),
      }));
    target = { ...t, notes };
  }

  const offices: CompanyOffice[] = ((officesRes.data) ?? []).map((o) => ({
    id: o.id,
    location_id: o.location_id,
    source: o.source,
    label: locationLabel(o.locations) ?? `Location ${o.location_id}`,
    city: o.locations?.city ?? null,
    state: o.locations?.state ?? null,
    country: o.locations?.country ?? null,
  }));

  return {
    company: companyRes.data as CompanyDetail["company"],
    target,
    offices,
    facets,
    current,
    former,
    bench,
  };
}

// ── Mutations ──────────────────────────────────────────────────────────

/** Bench → prospect ("Add to outreach"). */
export async function promoteContactToProspect(contactId: number) {
  const { error } = await db().from("contacts").update({ network_status: "prospect" }).eq("id", contactId);
  if (error) throw error;
}

/** Prospect → bench (demote). */
export async function demoteContactToBench(contactId: number) {
  const { error } = await db().from("contacts").update({ network_status: "bench" }).eq("id", contactId);
  if (error) throw error;
}

/**
 * Delete an office with the plan-24 cascade: dependent profile_match
 * employment locations are nulled (they were inferred FROM this office);
 * experience-sourced rows keep their location (first-person evidence)
 * but no longer imply an office.
 */
export async function deleteCompanyOffice(office: { id: number; location_id: number }, companyId: number) {
  const { error: clearError } = await db()
    .from("contact_companies")
    .update({ location_id: null, location_source: null })
    .eq("company_id", companyId)
    .eq("location_id", office.location_id)
    .eq("location_source", "profile_match");
  if (clearError) throw clearError;
  const { error } = await db().from("company_locations").delete().eq("id", office.id);
  if (error) throw error;

  // Deleting the office removes it from the scope dropdown; soft-untarget
  // the (RLS-scoped, own) target row for it so a targeted-but-invisible
  // ghost can't linger on the targets list. Pipeline data is kept and
  // resurfaces if the office is re-added.
  const { error: untargetError } = await db()
    .from("target_companies")
    .update({ is_targeted: false, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("location_id", office.location_id)
    .eq("is_targeted", true);
  if (untargetError) throw untargetError;
}

export async function addCompanyOffice(companyId: number, locationId: number) {
  const { error } = await db()
    .from("company_locations")
    .upsert({ company_id: companyId, location_id: locationId, source: "manual" }, { onConflict: "company_id,location_id", ignoreDuplicates: true });
  if (error) throw error;
}

export interface CompanyOfficeLocationInput {
  city: string | null;
  state: string | null;
  country: string;
}

export function normalizeCompanyOfficeLocationInput(input: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): CompanyOfficeLocationInput {
  return {
    city: input.city?.trim() || null,
    state: input.state?.trim() || null,
    country: input.country?.trim() || "United States",
  };
}

export function formatCompanyOfficeLocationLabel(location: CompanyOfficeLocationInput): string {
  if (location.city) return [location.city, location.state].filter(Boolean).join(", ");
  if (location.state) return [location.state, location.country].filter(Boolean).join(", ");
  return location.country;
}

export async function addCompanyOfficeLocation(
  companyId: number,
  input: { city?: string | null; state?: string | null; country?: string | null },
): Promise<{ locationId: number; added: boolean; label: string }> {
  const normalized = normalizeCompanyOfficeLocationInput(input);
  const location = await findOrCreateOfficeLocation(normalized);
  const label = formatCompanyOfficeLocationLabel(normalized);

  const existing = must(
    await db()
      .from("company_locations")
      .select("id")
      .eq("company_id", companyId)
      .eq("location_id", location.id)
      .maybeSingle(),
  );
  if (existing) {
    return { locationId: location.id, added: false, label };
  }

  await addCompanyOffice(companyId, location.id);
  return { locationId: location.id, added: true, label };
}

async function findOrCreateOfficeLocation(location: CompanyOfficeLocationInput): Promise<{ id: number }> {
  function buildLookup() {
    let q = db().from("locations").select("id");
    q = location.city ? q.eq("city", location.city) : q.is("city", null);
    q = location.state ? q.eq("state", location.state) : q.is("state", null);
    return q.eq("country", location.country);
  }

  const existing = must(await buildLookup().maybeSingle());
  if (existing) return existing as { id: number };

  const { data, error } = await db()
    .from("locations")
    .insert({
      city: location.city,
      state: location.state,
      country: location.country,
    })
    .select("id")
    .single();
  if (error) {
    // error-tolerated: this lookup only exists to recover from a concurrent
    // insert winning the unique constraint; if it fails too we fall through
    // and throw the original insert error, which is the more useful one.
    const { data: retry } = await buildLookup().maybeSingle();
    if (retry) return retry as { id: number };
    throw error;
  }
  return data as { id: number };
}

export interface ManualCompanyInput {
  name: string;
  linkedin_url: string | null;
  location: CompanyOfficeLocationInput | null;
}

/**
 * Normalize the add-company modal's raw fields. Returns null when no
 * usable name was given. A location counts as provided only when city or
 * state is filled — the country field is prefilled ("United States"), so
 * country alone doesn't imply the user meant to record an office.
 */
export function normalizeManualCompanyInput(input: {
  name?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): ManualCompanyInput | null {
  const name = input.name?.trim();
  if (!name) return null;
  const hasLocation = Boolean(input.city?.trim() || input.state?.trim());
  return {
    name,
    linkedin_url: input.linkedin_url?.trim() || null,
    location: hasLocation ? normalizeCompanyOfficeLocationInput(input) : null,
  };
}

/**
 * "Add company" from the companies page (CAR-34): find-or-create through
 * the shared identity path (never mints a duplicate row), ensure it's one
 * of the user's targets so it appears in the default view, and record an
 * office when a location was given.
 */
export async function addCompanyManually(
  userId: string,
  input: { name?: string | null; linkedin_url?: string | null; city?: string | null; state?: string | null; country?: string | null },
): Promise<{ companyId: number; companyName: string; alreadyTargeted: boolean }> {
  const normalized = normalizeManualCompanyInput(input);
  if (!normalized) throw new Error("Company name is required");

  const company = await findOrCreateCompany(db(), {
    name: normalized.name,
    linkedin_url: normalized.linkedin_url,
  });

  const { data: existingTarget, error: targetLookupError } = await db()
    .from("target_companies")
    .select("id, is_targeted")
    .eq("user_id", userId)
    .eq("company_id", company.id)
    .is("location_id", null)
    .maybeSingle();
  if (targetLookupError) throw targetLookupError;
  if (!existingTarget) await addTargetCompany(userId, company.id);
  else if (!(existingTarget as { is_targeted: boolean }).is_targeted) {
    await updateTargetCompanyTargeted((existingTarget as { id: number }).id, true);
  }

  if (normalized.location) {
    await addCompanyOfficeLocation(company.id, normalized.location);
  }

  return { companyId: company.id, companyName: company.name, alreadyTargeted: Boolean(existingTarget) };
}

export async function addTargetCompany(userId: string, companyId: number) {
  // A soft-untargeted company-wide row may already exist (CAR-6 keeps
  // pipeline data on un-target) — revive it instead of violating the
  // partial unique index.
  const { data: existing, error: lookupError } = await db()
    .from("target_companies")
    .select("id, is_targeted")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .is("location_id", null)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const row = existing as { id: number; is_targeted: boolean };
    if (!row.is_targeted) await updateTargetCompanyTargeted(row.id, true);
    return { id: row.id };
  }

  const { data, error } = await db()
    .from("target_companies")
    .insert({ user_id: userId, company_id: companyId })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: number };
}

export async function updateTargetCompanyTargeted(targetId: number, isTargeted: boolean) {
  const { error } = await db()
    .from("target_companies")
    .update({ is_targeted: isTargeted, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

/** Remove a company from the user's targets (notes cascade-delete). */
export async function removeTargetCompany(targetId: number) {
  const { error } = await db().from("target_companies").delete().eq("id", targetId);
  if (error) throw error;
}

export async function updateTargetCompany(
  targetId: number,
  patch: Partial<Pick<TargetInfo, "priority_score" | "tier" | "program_name" | "app_window_text" | "next_app_date" | "status">>,
) {
  const { error } = await db()
    .from("target_companies")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  if (error) throw error;
}

export async function addTargetCompanyNote(targetCompanyId: number, note: string, locationId?: number | null) {
  const { error } = await db()
    .from("target_company_notes")
    .insert({ target_company_id: targetCompanyId, note, location_id: locationId ?? null });
  if (error) throw error;
}

export async function deleteTargetCompanyNote(noteId: number) {
  const { error } = await db().from("target_company_notes").delete().eq("id", noteId);
  if (error) throw error;
}

/** Manual stage override ("mark as contacted" etc.); null clears it. */
export async function setStageOverride(contactId: number, stage: string | null) {
  const { error } = await db().from("contacts").update({ stage_override: stage }).eq("id", contactId);
  if (error) throw error;
}
