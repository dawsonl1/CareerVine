/**
 * Server-side analytics: PostHog capture + first-party Supabase mirror +
 * one-time milestone detection.
 *
 * Design constraints:
 * - Must never throw into product code and never add failure modes to the
 *   request path — every entry point swallows its own errors.
 * - Must work in three runtimes: Vercel serverless routes, the QStash cron
 *   routes, and the long-lived stdio MCP process. So no next/server imports;
 *   serverless flush-safety comes from callers awaiting the returned promise
 *   (api-handler awaits pending tracks before returning the response).
 * - No-ops cleanly when NEXT_PUBLIC_POSTHOG_KEY is unset (dev, tests, and
 *   until the PostHog project is provisioned).
 */

import { PostHog } from "posthog-node";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { EmailDirection } from "@/lib/constants";
import { isInternalUser } from "./internal";
import {
  MILESTONE_THRESHOLDS,
  MIRRORED_EVENTS,
  type AnalyticsEvent,
  type AnalyticsEvents,
  type Milestone,
  type Surface,
} from "./events";

let posthog: PostHog | null | undefined;
let serviceClient: ReturnType<typeof createSupabaseServiceClient> | null = null;

function getPosthog(): PostHog | null {
  if (posthog !== undefined) return posthog;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  posthog = key
    ? new PostHog(key, {
        host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
        // Serverless: send immediately rather than batching across a
        // lifetime the lambda doesn't have.
        flushAt: 1,
        flushInterval: 0,
      })
    : null;
  return posthog;
}

function getServiceClient() {
  if (!serviceClient) serviceClient = createSupabaseServiceClient();
  return serviceClient;
}

/** Test seam: reset module singletons (env changes between tests). */
export function _resetAnalyticsForTests(): void {
  posthog = undefined;
  serviceClient = null;
}

/**
 * Connection events double as person-state writers (CAR-58): each `$set`s the
 * current connection booleans on the PostHog person, so "who is connected
 * right now" is queryable via person properties regardless of when event
 * tracking shipped (all pre-CAR-38 connections have no gmail_connected event).
 * gmail_disconnected clears both flags because revokeAccess deletes the whole
 * gmail_connections row, calendar scopes included.
 */
const PERSON_STATE_PROPS: Partial<Record<AnalyticsEvent, Record<string, boolean>>> = {
  gmail_connected: { gmail_connected: true },
  gmail_disconnected: { gmail_connected: false, calendar_connected: false },
  calendar_connected: { calendar_connected: true },
  calendar_disconnected: { calendar_connected: false },
};

/**
 * Record an event for a user. Fire-and-forget safe (`void trackServer(...)`)
 * in long-lived processes; in serverless routes the caller should await it
 * (api-handler does this automatically for ctx.track) so the flush isn't
 * cut off by the lambda freezing.
 */
export async function trackServer<E extends AnalyticsEvent>(
  userId: string | null | undefined,
  event: E,
  props: AnalyticsEvents[E],
  surface: Surface = "server",
): Promise<void> {
  if (!userId) return;
  // Internal accounts produce no analytics — covers every server surface
  // (API routes, cron sends, both MCP processes) in one place (CAR-60/CAR-80).
  // Email-derived flag, resolved by user id and cached per process.
  // Milestones still record to user_milestones; only the events are dropped.
  if (await isInternalUser(userId)) return;
  const stateProps = PERSON_STATE_PROPS[event];
  const properties = {
    ...props,
    surface,
    ...(stateProps ? { $set: stateProps } : {}),
  };

  const jobs: Promise<unknown>[] = [];

  const ph = getPosthog();
  if (ph) {
    try {
      ph.capture({ distinctId: userId, event, properties });
      jobs.push(ph.flush());
    } catch {
      // analytics must never break the caller
    }
  }

  if ((MIRRORED_EVENTS as readonly string[]).includes(event)) {
    jobs.push(
      Promise.resolve(
        getServiceClient()
          .from("analytics_events")
          .insert({ user_id: userId, event, surface, properties: props }),
      ),
    );
  }

  if (jobs.length === 0) return;
  await Promise.allSettled(jobs);
}

/**
 * api_error guardrail for the QStash cron routes (CAR-58): they run outside
 * withApiHandler with no acting user, so route crashes were invisible to the
 * guardrail. Events attribute to a fixed system distinct id — the count is
 * what matters, not the person.
 */
export async function trackCronError(route: string): Promise<void> {
  await trackServer("system:cron", "api_error", { route, method: "POST" });
}

/**
 * One-time milestone: inserts into user_milestones and emits
 * milestone_reached only if this call is the first to cross it. The insert
 * winning (`on conflict do nothing` semantics via error code 23505) is the
 * dedupe — safe under concurrent requests.
 */
export async function reachMilestone(
  userId: string | null | undefined,
  milestone: Milestone,
): Promise<void> {
  if (!userId) return;
  try {
    const { error } = await getServiceClient()
      .from("user_milestones")
      .insert({ user_id: userId, milestone });
    if (error) return; // 23505 duplicate = already reached; anything else: stay silent
    await trackServer(userId, "milestone_reached", { milestone });
  } catch {
    // never throw into product code
  }
}

/**
 * Check count-threshold milestones after the actions that can cross them.
 * Cheap head-count queries; skips entirely once both milestones are reached
 * would require a read — at this scale the two counts are fine to run on
 * every import/send.
 */
export async function checkContactMilestone(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  try {
    const { count } = await getServiceClient()
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if ((count ?? 0) >= MILESTONE_THRESHOLDS.contacts_5) {
      await reachMilestone(userId, "contacts_5");
    }
  } catch {
    // analytics must never break the caller
  }
}

export async function checkCompaniesEmailedMilestone(
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    // Distinct companies among contacts this user has emailed: outbound
    // messages matched to a contact → that contact's company links.
    const service = getServiceClient();
    // Junction-scoped (CAR-159): an outbound to a shared thread credits every
    // linked contact's company, not just the single matched_contact_id.
    const { data: sent } = await service
      .from("email_message_contacts")
      .select("contact_id, email_messages!inner(user_id, direction)")
      .eq("email_messages.user_id", userId)
      .eq("email_messages.direction", EmailDirection.Outbound)
      .limit(1000);
    const contactIds = [...new Set((sent ?? []).map((r) => r.contact_id as number))];
    if (contactIds.length === 0) return;

    const { data: links } = await service
      .from("contact_companies")
      .select("company_id")
      .in("contact_id", contactIds.slice(0, 200));
    const companies = new Set((links ?? []).map((r) => r.company_id as number));
    if (companies.size >= MILESTONE_THRESHOLDS.companies_emailed_5) {
      await reachMilestone(userId, "companies_emailed_5");
    }
  } catch {
    // analytics must never break the caller
  }
}
