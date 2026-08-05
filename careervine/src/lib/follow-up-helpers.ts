/**
 * Shared helpers for follow-up message row construction and teardown.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FollowUpStatus,
  FollowUpMessageStatus,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";
import { zonedDateParts, zonedWallClockToUtc } from "@/lib/timezone";

/**
 * Cancel every active follow-up sequence linked to a scheduled email
 * (email_follow_ups.scheduled_email_id) plus their unresolved messages.
 * Runs after the scheduled email itself was cancelled: a sequence whose
 * opening email will never send must not keep firing follow-ups into a
 * thread that doesn't exist. Shared by the web DELETE route and the MCP
 * cancel_scheduled tool (CAR-136).
 */
export async function cancelFollowUpsForScheduledEmail(
  service: SupabaseClient,
  userId: string,
  scheduledEmailId: number,
  now: string = new Date().toISOString(),
): Promise<void> {
  // user_id scoping is defense-in-depth (CAR-151): the caller verified the
  // scheduled email's ownership, but this runs on the service client, so the
  // linkage read must not trust scheduled_email_id alone.
  const { data: linked, error: readError } = await service
    .from("email_follow_ups")
    .select("id")
    .eq("scheduled_email_id", scheduledEmailId)
    .eq("user_id", userId)
    .eq("status", FollowUpStatus.Active);
  if (readError) throw readError;
  if (!linked || linked.length === 0) return;

  const fuIds = linked.map((fu: { id: number }) => fu.id);
  const { error: msgError } = await service
    .from("email_follow_up_messages")
    .update({ status: FollowUpMessageStatus.Cancelled })
    .in("follow_up_id", fuIds)
    // Include expired so a still-sendable expired sibling isn't orphaned when
    // its parent scheduled email is cancelled (CAR-105).
    .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
  if (msgError) throw msgError;

  const { error: fuError } = await service
    .from("email_follow_ups")
    .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
    .in("id", fuIds)
    .eq("user_id", userId);
  if (fuError) throw fuError;
}

interface FollowUpMessageInput {
  sendAfterDays: number;
  subject: string;
  bodyHtml: string;
  sendTime?: string;
}

/** Send time used when a caller does not pick one. Local to the user's zone. */
export const DEFAULT_FOLLOW_UP_SEND_HOUR = 9;
export const DEFAULT_FOLLOW_UP_SEND_MINUTE = 5;

/** A local calendar date, as `zonedDateParts` returns it. */
export type LocalDateParts = { year: number; month: number; day: number };

/**
 * Parse an `HH:MM` send time into local hour/minute, falling back to the
 * defaults on anything malformed.
 *
 * The Zod schemas already pin the shape at the API boundary, so the range guard
 * here is for callers that skipped one: a "99:99" that reached
 * `zonedWallClockToUtc` would roll the DATE, silently moving a step to another
 * day rather than failing.
 */
export function parseSendTime(sendTime?: string): { hour: number; minute: number } {
  if (!sendTime) {
    return { hour: DEFAULT_FOLLOW_UP_SEND_HOUR, minute: DEFAULT_FOLLOW_UP_SEND_MINUTE };
  }
  const [h, min] = sendTime.split(":").map(Number);
  if (Number.isFinite(h) && Number.isFinite(min) && h >= 0 && h < 24 && min >= 0 && min < 60) {
    return { hour: h, minute: min };
  }
  return { hour: DEFAULT_FOLLOW_UP_SEND_HOUR, minute: DEFAULT_FOLLOW_UP_SEND_MINUTE };
}

/**
 * THE single authority for when a follow-up step is allowed to land.
 *
 * Two invariants, both bought with production incidents, and both of which a
 * second hand-rolled implementation would quietly drop:
 *
 * ── Every emitted instant is in the future (CAR-220) ────────────────────
 *
 * The send cron's due filter is a bare `scheduled_send_at <= now`, and the A1
 * watcher polls every ~15s, so a row written in the past is not "late", it is
 * DELIVERED — a real cold email leaving the moment the user hits save. Clamping
 * advances whole LOCAL days rather than snapping to `now`: the user asked for
 * 09:03, and 09:03 tomorrow honours that where 14:32 today does not.
 *
 * ── Steps stay strictly increasing ──────────────────────────────────────
 *
 * Without the running floor, a sequence whose first two steps both clamp
 * collapses into two emails at the same instant.
 *
 * Callers supply a LOCAL CALENDAR DATE rather than an instant, because the two
 * writers derive that date differently and only they know how: creation counts
 * `sendAfterDays` calendar days off the original send, while a reschedule keeps
 * the date each row already has. Everything after that decision is identical,
 * and lives here.
 *
 * The day-advance is bounded: the initial jump covers most of the gap in one
 * step (`sentAt` can be months old on the thread-anchored path), then at most
 * three single-day passes absorb a DST transition inside that jump, which can
 * otherwise leave it an hour short.
 */
export function clampFollowUpInstants(
  steps: Array<{ localDate: LocalDateParts; hour: number; minute: number }>,
  timeZone: string,
  now: Date = new Date(),
): Date[] {
  // Each step must clear both `now` and the step before it.
  let floorMs = now.getTime();

  return steps.map(({ localDate, hour, minute }) => {
    const at = (dayOffset: number) => {
      const { year, month, day } = shiftLocalDate(localDate, dayOffset);
      return zonedWallClockToUtc(year, month, day, hour, minute, timeZone);
    };

    let dayOffset = 0;
    let sendAt = at(dayOffset);
    if (sendAt.getTime() <= floorMs) {
      dayOffset += Math.max(1, Math.ceil((floorMs - sendAt.getTime()) / 86_400_000));
      sendAt = at(dayOffset);
      for (let guard = 0; sendAt.getTime() <= floorMs && guard < 3; guard++) {
        dayOffset += 1;
        sendAt = at(dayOffset);
      }
    }
    floorMs = sendAt.getTime();
    return sendAt;
  });
}

/** `dayOffset` calendar days after a local date. */
export function shiftLocalDate(
  { year, month, day }: LocalDateParts,
  dayOffset: number,
): LocalDateParts {
  // Date.UTC normalizes overflow, so day + 21 rolls the month and the year.
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Build database rows for follow-up messages.
 *
 * ── Times are LOCAL to `timeZone`, not UTC (CAR-215) ────────────────────
 *
 * This used to call `setUTCHours(9, 0)`, so every follow-up went out at 09:00
 * UTC no matter where the user was: 2:00 AM for a Mountain user, 1:00 AM
 * Pacific. A caller-picked `sendTime` was read the same way, so choosing
 * "9:00 AM" in the follow-up modal scheduled a 2 AM email. Worse, the sibling
 * route (`POST /api/email-follow-ups`) applied a browser offset instead, so the
 * same feature produced two different answers depending on which modal opened
 * it. Both now resolve through here against a real IANA zone.
 *
 * Day arithmetic is calendar-based rather than `+ n * 24h`, so "7 days later at
 * 9:05" stays literally true across a DST boundary instead of sliding an hour.
 *
 * ── Every emitted instant is in the future (CAR-220) ────────────────────
 *
 * `sentAt + sendAfterDays` at a local hour can land in the PAST, and the cron's
 * due filter is a bare `scheduled_send_at <= now`, so such a row is delivered
 * on the watcher's next ~15s tick. A user scheduling "3 days from now" would
 * watch a real cold email leave the moment they hit save.
 *
 * It is reachable from the modal's own defaults, not just odd input: the client
 * derives its minimum delay from raw 24-hour buckets while this computes from
 * the local calendar date, and the two disagree by up to a day. A Denver user
 * whose original went out at 18:00 local, adding a follow-up with the seeded
 * delay, produced an instant three hours behind `now`.
 *
 * So the floor is enforced HERE rather than in the client. The client fix is
 * still worth having (it stops the UI promising a date the server will move),
 * but this is the only chokepoint every caller passes through — web create, web
 * edit, and MCP.
 *
 * Clamping advances whole LOCAL days, never to `now`: the user asked for 09:00,
 * and 09:00 tomorrow honours that where 14:32 today does not. Steps are also
 * kept strictly increasing, so a sequence whose first two steps both clamp does
 * not collapse into two emails at the same instant.
 *
 * @param followUpId - The parent follow-up sequence ID
 * @param messages - Array of message inputs from the client
 * @param sentAt - The original email's sent date (used to compute scheduled dates)
 * @param timeZone - The recipient user's IANA zone; resolve it with `resolveUserTimeZone`
 * @param sequenceOffset - Starting sequence number (use to avoid collisions with already-sent messages)
 * @param now - Injectable clock; the future-floor is measured against it
 */
export function buildFollowUpMessageRows(
  followUpId: number,
  messages: FollowUpMessageInput[],
  sentAt: Date,
  timeZone: string,
  sequenceOffset: number = 0,
  now: Date = new Date(),
) {
  // Creation counts `sendAfterDays` CALENDAR days off the original send, so a
  // step keeps its wall clock across a DST boundary instead of sliding an hour.
  // The clamping that follows is shared with the reschedule path.
  const sentAtDate = zonedDateParts(sentAt, timeZone);
  const instants = clampFollowUpInstants(
    messages.map((m) => ({
      localDate: shiftLocalDate(sentAtDate, m.sendAfterDays),
      ...parseSendTime(m.sendTime),
    })),
    timeZone,
    now,
  );

  return messages.map((m, idx) => ({
    follow_up_id: followUpId,
    sequence_number: sequenceOffset + idx + 1,
    // The REQUESTED delay, not the clamped one: this is what the UI shows the
    // user ("Day 3"), and rewriting it would make the clamp invisible to them.
    send_after_days: m.sendAfterDays,
    subject: m.subject,
    body_html: m.bodyHtml,
    status: FollowUpMessageStatus.Pending,
    scheduled_send_at: instants[idx].toISOString(),
  }));
}

/** Prior open-step snapshot used when rebuilding a sequence on edit (CAR-125). */
export type PriorFollowUpMessageSnapshot = {
  sequence_number: number;
  send_after_days: number;
  status: string;
  parked_at: string | null;
  expires_at: string | null;
  reminder_count: number | null;
  last_reminder_at: string | null;
  seen_during_window: boolean | null;
};

type RebuildRow = {
  sequence_number: number;
  send_after_days: number;
  status: string;
  scheduled_send_at: string;
  subject: string;
  body_html: string;
  follow_up_id: number;
};

/**
 * After a follow-up edit rebuild, restore awaiting_review/expired + park metadata
 * when the step's delay is unchanged so "Send now" still works immediately.
 * A delay change is treated as an intentional reschedule → stays pending.
 */
export function reconcileFollowUpEditStatuses<T extends RebuildRow>(
  newRows: T[],
  priorBySequence: Map<number, PriorFollowUpMessageSnapshot>,
): Array<
  T & {
    parked_at?: string | null;
    expires_at?: string | null;
    reminder_count?: number;
    last_reminder_at?: string | null;
    seen_during_window?: boolean;
  }
> {
  return newRows.map((row) => {
    const prior = priorBySequence.get(row.sequence_number);
    if (
      prior &&
      (prior.status === FollowUpMessageStatus.AwaitingReview ||
        prior.status === FollowUpMessageStatus.Expired) &&
      prior.send_after_days === row.send_after_days
    ) {
      return {
        ...row,
        status: prior.status,
        parked_at: prior.parked_at,
        expires_at: prior.expires_at,
        reminder_count: prior.reminder_count ?? 0,
        last_reminder_at: prior.last_reminder_at,
        seen_during_window: prior.seen_during_window ?? false,
      };
    }
    return row;
  });
}
