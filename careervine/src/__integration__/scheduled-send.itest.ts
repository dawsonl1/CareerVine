/**
 * Money path against real PostgREST (CAR-178): scheduled-email claim / send /
 * mark-sent, the concurrent-claim race, the post-send failure window, policy
 * releases, and the follow-up stale-claim join shape.
 *
 * The REAL processScheduledEmails / processDueScheduledEmails run here with
 * the real local service client injected; only the Gmail transport
 * (sendTrackedEmail) is faked. This is the tier that proves the rule-17
 * count-based CAS actually claims exactly once on the running PostgREST
 * version — the unit suite's builder mocks encode our belief about PostgREST
 * and can never contradict it (learned rule 39).
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { processScheduledEmails } from "@/lib/gmail";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";
import { SendPolicyError, type sendTrackedEmail } from "@/lib/email-send";
import { ScheduledEmailStatus } from "@/lib/constants";
import {
  createTenant,
  deleteTenant,
  serviceClient,
  uniq,
  type Db,
  type Tenant,
} from "./helpers/stack";

type SendFn = typeof sendTrackedEmail;

let svc: Db;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  svc = serviceClient();
  a = await createTenant("sched-a");
  b = await createTenant("sched-b");
});

afterAll(async () => {
  if (a) await deleteTenant(a.userId);
  if (b) await deleteTenant(b.userId);
});

afterEach(async () => {
  // Each test seeds its own rows; user deletion in afterAll is the backstop.
  await svc.from("scheduled_emails").delete().in("user_id", [a.userId, b.userId]);
  await svc.from("email_follow_ups").delete().in("user_id", [a.userId, b.userId]);
});

interface SeedOpts {
  userId: string;
  status?: string;
  scheduledAt?: string;
  claimedAt?: string | null;
}

async function seedScheduled(opts: SeedOpts): Promise<number> {
  const { data, error } = await svc
    .from("scheduled_emails")
    .insert({
      user_id: opts.userId,
      recipient_email: `${uniq("to")}@example.com`,
      subject: uniq("subject"),
      body_html: "<p>hi</p>",
      scheduled_send_at: opts.scheduledAt ?? new Date(Date.now() - 60_000).toISOString(),
      status: opts.status ?? ScheduledEmailStatus.Pending,
      claimed_at: opts.claimedAt ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function getRow(id: number) {
  const { data, error } = await svc.from("scheduled_emails").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

function okSend(calls: { count: number; recipients: string[] }, delayMs = 0): SendFn {
  return (async (_userId: string, opts: { to: string }) => {
    calls.count += 1;
    calls.recipients.push(opts.to);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      messageId: uniq("gm"),
      threadId: uniq("th"),
      matchedContactId: null,
      capRemaining: 99,
      warnings: [],
    };
  }) as SendFn;
}

it("claims, sends, and marks sent — and stamps the linked follow-up", async () => {
  const id = await seedScheduled({ userId: a.userId });
  const { data: fu, error: fuErr } = await svc
    .from("email_follow_ups")
    .insert({
      user_id: a.userId,
      recipient_email: "target@example.com",
      original_sent_at: new Date().toISOString(),
      scheduled_email_id: id,
    })
    .select("id")
    .single();
  expect(fuErr).toBeNull();

  const calls = { count: 0, recipients: [] as string[] };
  const result = await processScheduledEmails(a.userId, { service: svc, send: okSend(calls) });

  expect(result).toEqual({ sent: 1, errors: 0 });
  expect(calls.count).toBe(1);
  const row = await getRow(id);
  expect(row.status).toBe(ScheduledEmailStatus.Sent);
  expect(row.gmail_message_id).toBeTruthy();
  expect(row.sent_thread_id).toBeTruthy();
  expect(row.sent_at).toBeTruthy();

  const { data: fuAfter } = await svc
    .from("email_follow_ups")
    .select("original_gmail_message_id, thread_id")
    .eq("id", fu!.id)
    .single();
  expect(fuAfter?.original_gmail_message_id).toBe(row.gmail_message_id);
  expect(fuAfter?.thread_id).toBe(row.sent_thread_id);
});

it("concurrent drivers racing one due row send exactly once (rule-17 CAS on real PostgREST)", async () => {
  const id = await seedScheduled({ userId: a.userId });
  const calls = { count: 0, recipients: [] as string[] };
  const send = okSend(calls, 200);

  const [r1, r2] = await Promise.all([
    processScheduledEmails(a.userId, { service: svc, send }),
    processScheduledEmails(a.userId, { service: svc, send }),
  ]);

  expect(calls.count, "exactly one Gmail send across both drivers").toBe(1);
  expect(r1.sent + r2.sent).toBe(1);
  expect(r1.errors + r2.errors).toBe(0);
  expect((await getRow(id)).status).toBe(ScheduledEmailStatus.Sent);
});

it("the bare claim CAS: second identical pending→sending update matches zero rows", async () => {
  const id = await seedScheduled({ userId: a.userId });
  const now = new Date().toISOString();
  const claim = () =>
    svc
      .from("scheduled_emails")
      .update({ status: ScheduledEmailStatus.Sending, claimed_at: now }, { count: "exact" })
      .eq("id", id)
      .eq("status", ScheduledEmailStatus.Pending);

  const first = await claim();
  expect(first.error).toBeNull();
  expect(first.count).toBe(1);

  const second = await claim();
  expect(second.error).toBeNull();
  expect(second.count).toBe(0);
});

it("post-send failure window: a stale 'sending' claim is swept to 'failed', never re-queued", async () => {
  // A driver died mid-send (possibly AFTER Gmail accepted the message): the
  // row sits in 'sending' with an old claim.
  const staleId = await seedScheduled({
    userId: a.userId,
    status: ScheduledEmailStatus.Sending,
    claimedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  });
  // A fresh claim must NOT be swept.
  const freshId = await seedScheduled({
    userId: a.userId,
    status: ScheduledEmailStatus.Sending,
    claimedAt: new Date().toISOString(),
  });

  const result = await processDueScheduledEmails(new Date().toISOString(), {
    service: svc,
    processForUser: async () => ({ sent: 0, errors: 0 }),
  });

  expect(result.sweptFailed).toBe(1);
  expect((await getRow(staleId)).status).toBe(ScheduledEmailStatus.Failed);
  expect((await getRow(freshId)).status).toBe(ScheduledEmailStatus.Sending);

  // 'failed' is terminal for automation: another pass sends nothing.
  const calls = { count: 0, recipients: [] as string[] };
  const after = await processScheduledEmails(a.userId, { service: svc, send: okSend(calls) });
  expect(after).toEqual({ sent: 0, errors: 0 });
  expect(calls.count).toBe(0);
});

it("a bounce (422) releases the claim back to pending and continues the batch", async () => {
  const bounceId = await seedScheduled({ userId: a.userId, scheduledAt: new Date(Date.now() - 120_000).toISOString() });
  const okId = await seedScheduled({ userId: a.userId });

  let first = true;
  const calls = { count: 0, recipients: [] as string[] };
  const send: SendFn = (async (userId: string, opts: { to: string }) => {
    if (first) {
      first = false;
      throw new SendPolicyError("bounced", 422);
    }
    return okSend(calls)(userId, opts as never);
  }) as SendFn;

  const result = await processScheduledEmails(a.userId, { service: svc, send });

  expect(result.sent).toBe(1);
  const bounced = await getRow(bounceId);
  expect(bounced.status).toBe(ScheduledEmailStatus.Pending);
  expect(bounced.claimed_at).toBeNull();
  expect((await getRow(okId)).status).toBe(ScheduledEmailStatus.Sent);
});

it("hitting the daily cap (429) stops the batch and releases the claim", async () => {
  const id1 = await seedScheduled({ userId: a.userId, scheduledAt: new Date(Date.now() - 120_000).toISOString() });
  const id2 = await seedScheduled({ userId: a.userId });

  let attempts = 0;
  const send: SendFn = (async () => {
    attempts += 1;
    throw new SendPolicyError("cap", 429);
  }) as SendFn;

  const result = await processScheduledEmails(a.userId, { service: svc, send });

  expect(result).toEqual({ sent: 0, errors: 0 });
  expect(attempts, "batch must stop after the first 429").toBe(1);
  for (const id of [id1, id2]) {
    const row = await getRow(id);
    expect(row.status).toBe(ScheduledEmailStatus.Pending);
    expect(row.claimed_at).toBeNull();
  }
});

it("processing user A never touches user B's due rows", async () => {
  const aId = await seedScheduled({ userId: a.userId });
  const bId = await seedScheduled({ userId: b.userId });

  const calls = { count: 0, recipients: [] as string[] };
  await processScheduledEmails(a.userId, { service: svc, send: okSend(calls) });

  expect(calls.count).toBe(1);
  expect((await getRow(aId)).status).toBe(ScheduledEmailStatus.Sent);

  const bRow = await getRow(bId);
  expect(bRow.status, "B's row must stay pending and unclaimed").toBe(ScheduledEmailStatus.Pending);
  expect(bRow.claimed_at).toBeNull();
});

it("the follow-up stale-claim sweep's !inner join shape returns the parent status", async () => {
  // The send-follow-ups cron splits stale 'sending' rows on the PARENT
  // sequence's status via `email_follow_ups!inner(status)` — a PostgREST
  // semantics dependency (embedded resource shape) that mocks cannot verify.
  const mk = async (parentStatus: string) => {
    const { data: fu, error } = await svc
      .from("email_follow_ups")
      .insert({
        user_id: a.userId,
        recipient_email: "t@example.com",
        original_sent_at: new Date().toISOString(),
        status: parentStatus,
      })
      .select("id")
      .single();
    if (error) throw error;
    const { error: msgErr } = await svc.from("email_follow_up_messages").insert({
      follow_up_id: fu.id,
      sequence_number: 1,
      send_after_days: 3,
      subject: "s",
      body_html: "<p>b</p>",
      scheduled_send_at: new Date().toISOString(),
      status: "sending",
      claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    if (msgErr) throw msgErr;
    return fu.id;
  };
  const activeParent = await mk("active");
  const deadParent = await mk("cancelled_user");

  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data, error } = await svc
    .from("email_follow_up_messages")
    .select("id, follow_up_id, email_follow_ups!inner(status)")
    .eq("status", "sending")
    .lt("claimed_at", staleCutoff)
    .in("follow_up_id", [activeParent, deadParent]);

  expect(error).toBeNull();
  expect(data).toHaveLength(2);
  for (const row of data ?? []) {
    const parent = Array.isArray(row.email_follow_ups)
      ? row.email_follow_ups[0]
      : row.email_follow_ups;
    const expected = row.follow_up_id === activeParent ? "active" : "cancelled_user";
    expect(parent?.status).toBe(expected);
  }
});
