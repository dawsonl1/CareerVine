/**
 * Gmail API service module
 *
 * Handles OAuth token management, email fetching, and contact-based sync.
 * Tokens are stored in the gmail_connections table via the service client
 * (bypasses RLS so API routes can read/write tokens server-side).
 */

import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  EmailDirection,
  FollowUpMessageStatus,
  FollowUpStatus,
  ScheduledEmailStatus,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";
import { getHeader, parseEmailAddress, buildOwnAddressSet, isBounceSenderAddress } from "@/lib/gmail-helpers";
import type { ParsedHeader } from "@/lib/gmail-helpers";
import type { gmail_v1 } from "@googleapis/gmail";
import { getOAuth2Client, decryptOAuthToken } from "@/lib/oauth-helpers";
import { getGmailClient, getConnection, buildMimeMessage, type ComposeEmailOptions } from "@/lib/gmail-send-core";
import { sendTrackedEmail, SendPolicyError } from "@/lib/email-send";
import { trackServer } from "@/lib/analytics/server";
import { googleApiStatus, googleApiReason } from "@/lib/google-api-error";
import { must } from "@/lib/data/client";
import { paginateAll } from "@/lib/data/postgrest";
import { extractFailedRecipients, needsFullFetch } from "@/lib/bounce-parse";
import { cancelFollowUpsForRepliedThreads } from "@/lib/follow-up-helpers";
import { sendBounceAlert, type BounceAlertOutcome } from "@/lib/notify/send-bounce-alert";
import type { BounceAlertItem } from "@/lib/notify/bounce-alert";

/**
 * Retry a function with exponential backoff on rate-limit (429), server errors
 * (5xx), or Gmail's 403-shaped rate limits (`rateLimitExceeded` /
 * `userRateLimitExceeded` — CAR-153/R2.2: the likeliest way a multi-page
 * backfill gets interrupted). Non-rate-limit 403s (missing scope, policy)
 * still throw immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = googleApiStatus(err);
      const reason = googleApiReason(err);
      const isRateLimited403 =
        status === 403 &&
        typeof reason === "string" &&
        /ratelimitexceeded/i.test(reason);
      // A transport failure ("ENOTFOUND") yields no numeric status and is not
      // retried here, matching the previous behaviour: the old string `code`
      // compared false against both 429 and the 5xx range.
      const isRetryable =
        status === 429 || isRateLimited403 || (status !== undefined && status >= 500 && status < 600);
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 10000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// CAR-102: the free tier requests only SENSITIVE scopes (sign-in + gmail.send,
// optionally calendar) so Google verification needs no CASA and lifts the 100-user
// cap. The RESTRICTED gmail.modify scope (the live mailbox) is added ONLY for a
// premium connect/reconnect, so the default consent screen is sensitive-only.
const SIGN_IN_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

const FREE_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
];

const RESTRICTED_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
];

// CAR-111: least-privilege calendar set. calendar.readonly covers every calendar
// READ the app makes (events.list/get, freebusy.query, calendarList.list for the
// busy-calendar picker, settings.get for timezone); calendar.events covers the
// WRITES (create/update/delete meetings + invites + Meet links). Deliberately NOT
// the full `calendar` scope (kept below only as the legacy superset for grant
// detection) — the app never manages calendars, sharing/ACL, or settings-writes,
// and the narrower set verifies faster with Google (no CASA either way, both are
// sensitive). The restricted gmail.modify path is unchanged.
const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// Legacy full-access scope: no longer requested, but pre-narrowing connections may
// still hold it, and it is a superset that covers both read and write.
const CALENDAR_FULL_LEGACY_SCOPE = "https://www.googleapis.com/auth/calendar";

const CALENDAR_SCOPES = [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE];

/**
 * Derive connection capability flags from the space-separated scope string Google
 * returns on the token. Lives next to the scope definitions so "which scopes grant
 * which capability" can't drift from what we request.
 *
 * CAR-111: Calendar requires BOTH read (`calendar.readonly`) AND write
 * (`calendar.events`). The two are separately grantable on Google's granular
 * consent screen, so a partial grant of only one is treated as NOT connected — the
 * user is re-prompted to reconnect rather than silently hitting a mid-feature 403
 * (free/busy + the calendar picker need read; creating a meeting needs write). The
 * legacy full `calendar` scope is a superset that satisfies both, so connections
 * made before the narrowing keep working.
 */
export function deriveGrantedScopeFlags(scopeParam: string | null | undefined): {
  sendGranted: boolean;
  calendarGranted: boolean;
  modifyGranted: boolean;
} {
  const granted = scopeParam?.split(" ").filter(Boolean) ?? [];
  const has = (scope: string) => granted.includes(scope);

  const calendarRead = has(CALENDAR_FULL_LEGACY_SCOPE) || has(CALENDAR_READONLY_SCOPE);
  const calendarWrite = has(CALENDAR_FULL_LEGACY_SCOPE) || has(CALENDAR_EVENTS_SCOPE);

  return {
    // gmail.modify is a superset of send; the legacy full-mail scope covers it too.
    sendGranted:
      granted.some((s) => s.includes("gmail.send") || s.includes("gmail.modify")) ||
      has("https://mail.google.com/"),
    calendarGranted: calendarRead && calendarWrite,
    modifyGranted: granted.some((s) => s.includes("gmail.modify")),
  };
}

/**
 * Generate the Google consent URL. The default (a new or free connect) requests
 * only sensitive scopes. Premium reconnects pass `includeModify` so the restricted
 * gmail.modify scope is preserved — the caller (the auth route) decides this from
 * the user's CURRENT premium state, so a premium user is never silently down-scoped
 * by reconnecting or adding calendar (CAR-102).
 */
export function getAuthUrl(
  state: string,
  opts: { includeCalendar?: boolean; includeModify?: boolean } = {},
): string {
  const oauth2Client = getOAuth2Client();
  const scopes = [
    ...SIGN_IN_SCOPES,
    ...FREE_GMAIL_SCOPES,
    ...(opts.includeModify ? RESTRICTED_GMAIL_SCOPES : []),
    ...(opts.includeCalendar ? CALENDAR_SCOPES : []),
  ];
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });
}

/**
 * Revoke the Google token and delete all Google-derived data for a user.
 * The OAuth grant covers Gmail AND Calendar, so a full revoke must clear the
 * cached calendar_events too (CAR-156 / R4.6) — otherwise event titles and
 * attendee lists outlive the connection that justified caching them. The
 * calendar-only disconnect route clears the same table but keeps the grant.
 */
export async function revokeAccess(userId: string) {
  const supabase = createSupabaseServiceClient();

  // maybeSingle, not single: "no connection row" is a normal state here (the
  // cleanup below still has to run), while a real read failure must surface
  // rather than silently skipping the Google-side token revoke.
  const conn = must(
    await supabase
      .from("gmail_connections")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle(),
  );

  if (conn?.access_token) {
    try {
      const oauth2Client = getOAuth2Client();
      await oauth2Client.revokeToken(decryptOAuthToken(conn.access_token));
    } catch {
      // Token may already be invalid — continue with cleanup
    }
  }

  // Reset the per-contact ingestion state BEFORE deleting the cache it
  // describes (CAR-172). email_synced_through survives the wipe below (it
  // lives on contacts), and a reconnect resuming from it would never re-fetch
  // the deleted span — silent, unrecoverable history loss. Order + throw are
  // the safety argument: a failed reset aborts the wipe (retryable, nothing
  // lost yet), whereas wiping first could strand deleted data behind a live
  // watermark, which is exactly the bug.
  const { error: resetError } = await supabase
    .from("contacts")
    .update({ email_synced_through: null, email_backfilled_at: null })
    .eq("user_id", userId)
    .or("email_synced_through.not.is.null,email_backfilled_at.not.is.null");
  if (resetError) throw resetError;

  await supabase.from("email_messages").delete().eq("user_id", userId);
  await supabase.from("calendar_events").delete().eq("user_id", userId);
  await supabase.from("gmail_connections").delete().eq("user_id", userId);
}

// ── Email sync helpers ──

/**
 * Sync emails for a specific contact by querying Gmail for messages
 * to/from the contact's known email addresses.
 *
 * `ownAddresses` is the user's primary Gmail address plus their send-as
 * aliases (see ownAddressesFromConnection) — mail From any of them is
 * classified outbound (CAR-153/R2.5).
 *
 * Resume point (CAR-153/R2.2): `contacts.email_synced_through` is a
 * completion-gated watermark — it advances to this sync's start time only
 * when the pagination loop finishes without throwing. It must NEVER be
 * derived from max(cached message date): Gmail lists newest-first, so an
 * interrupted backfill caches the newest page and a max-date resume would
 * skip the older uncached span forever.
 */
export async function syncEmailsForContact(
  userId: string,
  contactId: number,
  contactEmails: string[],
  ownAddresses: string[] | string,
  sinceDays = 90,
  opts: {
    /**
     * Pre-fetched contacts.email_synced_through (null = never completed).
     * Pass it when the caller already has the row (syncAllContactEmails
     * batches it per page); leave undefined to fetch here.
     */
    syncedThrough?: string | null;
  } = {}
) {
  if (contactEmails.length === 0) return 0;

  const gmail = await getGmailClient(userId);
  const supabase = createSupabaseServiceClient();
  const ownAddressSet = buildOwnAddressSet(
    typeof ownAddresses === "string" ? ownAddresses : null,
    typeof ownAddresses === "string" ? undefined : ownAddresses
  );

  // Capture the watermark candidate BEFORE listing: messages that arrive
  // while the loop runs are covered by the next pass's 1-day overlap.
  const syncStartedAt = new Date();

  let syncedThrough: string | null;
  if (opts.syncedThrough !== undefined) {
    syncedThrough = opts.syncedThrough;
  } else {
    const contactRow = must(
      await supabase
        .from("contacts")
        .select("email_synced_through")
        .eq("id", contactId)
        .maybeSingle(),
    );
    syncedThrough = contactRow?.email_synced_through ?? null;
  }

  // 1-day overlap buffer against clock skew and same-moment arrivals;
  // re-fetches dedupe via the ignoreDuplicates upsert below.
  let afterEpoch: number;
  if (syncedThrough) {
    afterEpoch = Math.floor((new Date(syncedThrough).getTime() - 86400_000) / 1000);
  } else {
    afterEpoch = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);
  }

  const emailQuery = contactEmails.map((e) => `from:${e} OR to:${e}`).join(" OR ");
  const query = `(${emailQuery}) after:${afterEpoch}`;

  let pageToken: string | undefined;
  let totalSynced = 0;
  // Completion-gate bookkeeping (CAR-159): a swallowed DB-write failure inside
  // the loop must NOT let the watermark advance. Attribution is now two writes
  // (the message row AND its email_message_contacts link); readers are
  // junction-only, so a lost link is a permanently invisible message unless the
  // next sync re-covers it. Tracking failures and holding the watermark makes
  // the next pass re-fetch and re-link the span — the same contract a thrown
  // error already honors, extended to the errors we log-and-continue on.
  let pageFailed = false;

  do {
    const listRes = await withRetry(() => gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    }));

    const messageIds = (listRes.data.messages || []).map((m) => m.id!);
    if (messageIds.length === 0) break;

    // Fetch metadata for each message in parallel (batched)
    const batchSize = 20;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((id) =>
          withRetry(() => gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          }))
        )
      );

      const rows = details.map((res) => {
        const msg = res.data;
        const headers = (msg.payload?.headers || []) as ParsedHeader[];
        const from = getHeader(headers, "From");
        const to = getHeader(headers, "To");
        const fromAddr = parseEmailAddress(from);
        const toAddrs = to.split(",").map(parseEmailAddress).filter(Boolean);
        // Alias-aware direction (R2.5): From any own address (primary or
        // send-as alias) is outbound. Strict primary-equality misread
        // alias-sent mail as inbound — false prospect activations and
        // false reply_received events downstream.
        const isOutbound = ownAddressSet.has(fromAddr);

        return {
          user_id: userId,
          gmail_message_id: msg.id!,
          thread_id: msg.threadId || null,
          subject: getHeader(headers, "Subject") || null,
          snippet: msg.snippet || null,
          from_address: fromAddr,
          to_addresses: toAddrs,
          date: (() => {
            const raw = getHeader(headers, "Date");
            if (!raw) return null;
            try {
              const d = new Date(raw);
              return isNaN(d.getTime()) ? null : d.toISOString();
            } catch { return null; }
          })(),
          label_ids: msg.labelIds || [],
          is_read: !(msg.labelIds || []).includes("UNREAD"),
          direction: isOutbound ? "outbound" : "inbound",
          matched_contact_id: contactId,
        };
      });

      // Look up which messages already exist so we can skip overwriting
      // user-managed fields (is_read, is_trashed, is_hidden)
      const msgIds = rows.map((r) => r.gmail_message_id);
      const existing = must(
        await supabase
          .from("email_messages")
          .select("gmail_message_id")
          .eq("user_id", userId)
          .in("gmail_message_id", msgIds),
      );
      const existingIds = new Set((existing || []).map((e) => e.gmail_message_id));

      const newRows = rows.filter((r) => !existingIds.has(r.gmail_message_id));
      const existingRows = rows.filter((r) => existingIds.has(r.gmail_message_id));

      // Insert new messages (includes is_read from Gmail). ignoreDuplicates
      // makes this ON CONFLICT DO NOTHING, and RETURNING then contains only
      // the rows THIS call actually inserted — so a concurrent sync of the
      // same contact (manual sync overlapping the cron pass) can't both
      // claim the same message and double-fire reply_received (CAR-58).
      if (newRows.length > 0) {
        const { data: insertedRows, error } = await supabase
          .from("email_messages")
          .upsert(newRows, {
            onConflict: "user_id,gmail_message_id",
            ignoreDuplicates: true,
          })
          // from_address rides along for the NDR filter below: an insert-time
          // column, so it costs nothing beyond the RETURNING it was already doing.
          .select("gmail_message_id, thread_id, direction, from_address");
        if (error) { console.error("Insert error:", error); pageFailed = true; }
        const inserted = insertedRows ?? [];

        // Non-NDR inbound rows THIS call created. An NDR is a delivery failure,
        // not the contact writing back: detectBounces owns it (cancelled_bounce),
        // and reading one as a reply would activate the very contact whose
        // address just failed. Same stance syncThreadReplies takes at its ingest.
        const replies = inserted.filter(
          (r) => r.direction === "inbound" && !isBounceSenderAddress(r.from_address ?? ""),
        );

        // An inbound message means the contact wrote back — that reply is
        // what graduates imported prospects/bench into the active network
        // (plan 24 tier transition). Outbound-only threads never graduate.
        if (replies.length > 0) {
          // Inline user_id scoping (CAR-151): contactId comes from this
          // user's sync loop, but a service-role write carries its own scope.
          const { error: actError } = await supabase
            .from("contacts")
            .update({ network_status: "active" })
            .eq("id", contactId)
            .eq("user_id", userId)
            .in("network_status", ["prospect", "bench"]);
          if (actError) console.error("Failed to activate contact on reply:", actError);

          // CAR-38 north-star event: thread-attributed replies only — a new
          // inbound message counts as reply_received iff we previously sent
          // an outbound message on the same thread. The insert above is the
          // dedupe: only rows this call created are attributed, so re-syncs
          // and concurrent syncs can't recount. ai_assisted comes from the
          // outbound side of the thread (stamped at send time, CAR-58).
          const inbound = replies.filter((r) => r.thread_id);
          const threadIds = [...new Set(inbound.map((r) => r.thread_id as string))];

          // CAR-233: the reply is in hand, so retire its follow-up sequence NOW
          // rather than leaving it scheduled until the send cron's next
          // threads.get happens to notice. Costs no Gmail call and nothing on
          // any page load — this only runs on a sync that actually ingested a
          // reply. Error-tolerated like the activation above it: the cron's
          // send-time check is still the backstop, so a failure here delays the
          // cancel rather than losing it, and must not fail the user's sync.
          if (threadIds.length > 0) {
            try {
              await cancelFollowUpsForRepliedThreads(supabase, userId, threadIds);
            } catch (err) {
              console.error("Failed to cancel follow-ups on synced reply:", err);
            }
          }

          if (threadIds.length > 0) {
            // error-tolerated: this only decides whether to emit the
            // reply_received analytics event; the user's mail sync must not
            // fail because an attribution lookup did.
            const { data: ourThreads } = await supabase
              .from("email_messages")
              .select("thread_id, ai_assisted")
              .eq("user_id", userId)
              .eq("direction", "outbound")
              .in("thread_id", threadIds);
            const attributed = new Map<string, boolean>();
            for (const t of ourThreads ?? []) {
              if (!t.thread_id) continue;
              attributed.set(t.thread_id, (attributed.get(t.thread_id) ?? false) || t.ai_assisted === true);
            }
            for (const r of inbound) {
              if (!attributed.has(r.thread_id as string)) continue;
              await trackServer(userId, "reply_received", {
                ai_assisted: attributed.get(r.thread_id as string) ?? false,
              });
            }
          }
        }
      }

      // Update existing messages: only safe fields (subject, snippet, label_ids)
      // Never overwrite is_read, is_trashed, or is_hidden
      for (const row of existingRows) {
        const { error } = await supabase
          .from("email_messages")
          .update({
            subject: row.subject,
            snippet: row.snippet,
            label_ids: row.label_ids,
            thread_id: row.thread_id,
          })
          .eq("user_id", userId)
          .eq("gmail_message_id", row.gmail_message_id);
        if (error) console.error("Update error:", error);
      }

      // Multi-contact attribution (CAR-159): every message in this page is by
      // construction about contactId (the Gmail query is scoped to their
      // addresses), so link them all — including rows another contact's sync
      // inserted first, which matched_contact_id alone can never attribute
      // here. The ids come from a post-upsert lookup rather than the RETURNING
      // set + pre-upsert lookup, so a row a concurrent sync inserts between
      // the two still gets its link this pass.
      const { data: pageRows, error: pageRowsError } = await supabase
        .from("email_messages")
        .select("id")
        .eq("user_id", userId)
        .in("gmail_message_id", msgIds);
      if (pageRowsError) {
        console.error("Junction id lookup error:", pageRowsError);
        pageFailed = true;
      } else if ((pageRows ?? []).length > 0) {
        const { error: linkError } = await supabase
          .from("email_message_contacts")
          .upsert(
            (pageRows ?? []).map((r) => ({ email_message_id: r.id, contact_id: contactId })),
            { onConflict: "email_message_id,contact_id", ignoreDuplicates: true }
          );
        if (linkError) { console.error("Junction link error:", linkError); pageFailed = true; }
      }

      totalSynced += rows.length;
    }

    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken);

  // Completion gate: only a pass that drained every page AND persisted every
  // row + link moves the watermark. A throw anywhere above leaves it untouched,
  // and a swallowed message-insert or junction-link failure (pageFailed) does
  // the same, so the next sync re-covers the span instead of hiding the hole.
  // Holding the watermark re-fetches (idempotent) rather than stranding a
  // message with no per-contact attribution. Failure to stamp is non-fatal
  // (worst case: the next pass re-fetches and dedupes).
  if (pageFailed) {
    console.warn(`Skipping email watermark advance for contact ${contactId}: a write failed this pass; next sync will re-cover.`);
  } else {
    const { error: watermarkError } = await supabase
      .from("contacts")
      .update({ email_synced_through: syncStartedAt.toISOString() })
      .eq("id", contactId);
    if (watermarkError) {
      console.error(`Failed to advance email watermark for contact ${contactId}:`, watermarkError);
    }
  }

  return totalSynced;
}

/**
 * List the user's send-as aliases (lowercased), primary included.
 * users.settings.sendAs.list is covered by the gmail.modify scope; free
 * (send-only) connections cannot call it — callers must gate on
 * modify_scope_granted and fall back to the primary address.
 *
 * `maxRetries: 0` makes it a single fast-fail attempt — used on the OAuth
 * callback where backoff sleeps would sit on a user-facing redirect.
 */
export async function fetchSendAsAliases(gmail: gmail_v1.Gmail, maxRetries = 3): Promise<string[]> {
  const res = await withRetry(() => gmail.users.settings.sendAs.list({ userId: "me" }), maxRetries);
  return (res.data.sendAs || [])
    .map((s) => s.sendAsEmail?.toLowerCase().trim())
    .filter((e): e is string => Boolean(e));
}

export interface SyncAllResult {
  /** Messages written to the cache this pass. */
  totalSynced: number;
  /** Contacts with emails that were attempted this pass. */
  processedContacts: number;
  /** Contacts whose sync threw (bad token, rate limit, etc.). */
  failedContacts: number;
  /** Non-null when the time budget ran out — pass back to resume. */
  nextCursor: number | null;
}

// One Gmail query per contact means a full pass can outlast a single
// serverless invocation. The loop stops before the route's maxDuration and
// hands back a cursor so the client can immediately continue where it left off.
const SYNC_TIME_BUDGET_MS = 45_000;
const SYNC_CONTACT_PAGE = 1000;
// Small pool (CAR-153/R3.4): parallel enough to matter, small enough to stay
// far from Gmail per-user rate limits (each contact costs 1 list + N gets).
const SYNC_CONCURRENCY = 4;

/**
 * Full sync: iterate through all contacts with email addresses
 * and sync Gmail messages for each, in contact-id order.
 *
 * Contacts are fetched in pages (a single query is capped at 1000 rows) and
 * processed through a bounded pool (SYNC_CONCURRENCY) until the time budget
 * runs out; `nextCursor` resumes the pass. The budget gates LAUNCHING only —
 * every launched sync is awaited before returning, and the cursor is the
 * highest CONTIGUOUS settled contact id, so out-of-order completion can never
 * skip a contact. `last_gmail_sync_at` is only stamped when a pass reaches
 * the end, so a partial or all-failed pass never masquerades as a completed
 * sync.
 */
export async function syncAllContactEmails(
  userId: string,
  sinceDays = 90,
  opts: { cursor?: number; budgetMs?: number } = {}
): Promise<SyncAllResult> {
  const supabase = createSupabaseServiceClient();

  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const budgetMs = opts.budgetMs ?? SYNC_TIME_BUDGET_MS;
  const startedAt = Date.now();

  // Opportunistic alias refresh (R2.5): keeps direction classification
  // current as users add/remove send-as addresses. Best-effort — a failure
  // falls back to the stored set — and modify-gated, since send-only
  // connections cannot read Gmail settings. Only on the FIRST pass of a
  // sync: cursor-resumed passes reuse the stored set instead of re-spending
  // a Gmail settings call + DB write per pass.
  let ownAddresses: string[] = [...buildOwnAddressSet(conn.gmail_address, conn.send_as_aliases)];
  if (conn.modify_scope_granted && opts.cursor == null) {
    try {
      const gmail = await getGmailClient(userId);
      const aliases = await fetchSendAsAliases(gmail);
      ownAddresses = [...buildOwnAddressSet(conn.gmail_address, aliases)];
      // Persist failures surface as an error VALUE, not a throw — log them,
      // or a chronically failing write leaves the stored set stale for the
      // cron/reply/calendar readers with zero signal.
      const { error: aliasPersistError } = await supabase
        .from("gmail_connections")
        .update({ send_as_aliases: aliases, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      if (aliasPersistError) {
        console.warn("Persisting send-as aliases failed (stored set stale):", aliasPersistError);
      }
    } catch (err) {
      console.warn("Send-as alias refresh failed (using stored set):", err);
    }
  }

  let lastDoneId = opts.cursor ?? 0;
  let totalSynced = 0;
  let processedContacts = 0;
  let failedContacts = 0;
  let launchedContacts = 0;
  let nextCursor: number | null = null;

  paging: while (true) {
    const { data: contacts, error } = await supabase
      .from("contacts")
      .select("id, email_synced_through, contact_emails(email)")
      .eq("user_id", userId)
      .gt("id", lastDoneId)
      .order("id", { ascending: true })
      .range(0, SYNC_CONTACT_PAGE - 1);

    if (error) throw error;
    if (!contacts || contacts.length === 0) break;

    // Contiguous-cursor bookkeeping: a contact is "settled" when its sync
    // finished (success OR failure) or it had no emails. The cursor only
    // advances across an unbroken settled prefix, so contact N+1 finishing
    // before contact N can never make the resume skip N.
    const settled: boolean[] = new Array(contacts.length).fill(false);
    let contiguousIdx = 0;
    const advanceCursor = () => {
      while (contiguousIdx < contacts.length && settled[contiguousIdx]) {
        lastDoneId = contacts[contiguousIdx].id;
        contiguousIdx++;
      }
    };

    const inFlight = new Set<Promise<void>>();
    let budgetExhausted = false;

    for (let idx = 0; idx < contacts.length; idx++) {
      const contact = contacts[idx];
      const emails = (contact.contact_emails || [])
        .map((e: { email: string | null }) => e.email)
        .filter(Boolean) as string[];

      if (emails.length === 0) {
        settled[idx] = true;
        advanceCursor();
        continue;
      }

      // Always make progress: only stop launching after ≥1 contact launched.
      if (launchedContacts > 0 && Date.now() - startedAt >= budgetMs) {
        budgetExhausted = true;
        break;
      }

      launchedContacts++;
      const task = (async () => {
        try {
          // Deliberately NOT `totalSynced += await ...`: compound assignment
          // reads the accumulator BEFORE the await suspends, so concurrent
          // pooled tasks would capture the same base and clobber each other's
          // additions (lost update). Await first, then add synchronously.
          const synced = await syncEmailsForContact(
            userId,
            contact.id,
            emails,
            ownAddresses,
            sinceDays,
            // Batched watermark (R3.4): the page query above already carries
            // email_synced_through, so the per-contact lookup is skipped.
            { syncedThrough: contact.email_synced_through ?? null }
          );
          totalSynced += synced;
        } catch (err) {
          failedContacts++;
          console.error(`Sync failed for contact ${contact.id}:`, err);
        }
        processedContacts++;
        settled[idx] = true;
        advanceCursor();
      })();
      const tracked: Promise<void> = task.then(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);

      if (inFlight.size >= SYNC_CONCURRENCY) {
        await Promise.race(inFlight);
      }
    }

    // Drain: never abandon a launched sync — the serverless freeze after the
    // response would kill it mid-pagination, and the cursor math relies on
    // every launched contact being settled.
    await Promise.all(inFlight);

    if (budgetExhausted) {
      nextCursor = lastDoneId;
      break paging;
    }

    if (contacts.length < SYNC_CONTACT_PAGE) break;
  }

  if (nextCursor === null) {
    await supabase
      .from("gmail_connections")
      .update({ last_gmail_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  return { totalSynced, processedContacts, failedContacts, nextCursor };
}

// Warm-contact gate for backfillEmailsForContact: within this window a
// completed backfill is not repeated. The email_backfilled_at stamp is nulled
// by the contact_emails_reset_sync_state trigger whenever the contact gains an
// address, so the gate only ever suppresses warm REPEATS — a new address
// backfills on the very next call (CAR-172).
const BACKFILL_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Backfill email_messages attribution for a contact.
 *
 * When a contact gains an email address (creation, import, or edit), there may
 * already be cached email_messages with that address. Two passes:
 *   1. Legacy claim: orphaned rows (matched_contact_id IS NULL) get this
 *      contact as their denormalized primary — transition-era behavior kept
 *      so nothing reading matched_contact_id breaks.
 *   2. Junction links (CAR-159): EVERY message involving the address — claimed
 *      by another contact or not — gets an email_message_contacts link, so a
 *      thread shared with an already-tracked contact appears on this one too.
 *
 * Called per page view (GET /api/gmail/emails), so it gates itself on
 * `contacts.email_backfilled_at` (CAR-172): a contact backfilled within
 * BACKFILL_STALE_MS is a no-op instead of a billed full-scan. The stamp is
 * completion-gated like the sync watermark — a swallowed claim/junction
 * failure holds it so the next call retries.
 */
export async function backfillEmailsForContact(
  userId: string,
  contactId: number,
  contactEmails: string[],
  opts: {
    /**
     * Pre-fetched contacts.email_backfilled_at (null = never completed or
     * reset by an address change). Pass it when the caller already has the
     * contact row (the emails route reads it for the ownership check); leave
     * undefined to fetch here.
     */
    backfilledAt?: string | null;
  } = {}
) {
  if (contactEmails.length === 0) return 0;

  const supabase = createSupabaseServiceClient();

  let backfilledAt: string | null;
  if (opts.backfilledAt !== undefined) {
    backfilledAt = opts.backfilledAt;
  } else {
    const contactRow = must(
      await supabase
        .from("contacts")
        .select("email_backfilled_at")
        .eq("id", contactId)
        .maybeSingle(),
    );
    backfilledAt = contactRow?.email_backfilled_at ?? null;
  }

  if (backfilledAt && Date.now() - new Date(backfilledAt).getTime() < BACKFILL_STALE_MS) {
    return 0;
  }

  // Captured BEFORE the scans, like the sync watermark: messages cached while
  // this pass runs fall after the stamp and are re-covered next time.
  const backfillStartedAt = new Date();
  let passFailed = false;

  const lowerEmails = contactEmails.map((e) => e.toLowerCase());

  let totalMatched = 0;
  for (const email of lowerEmails) {
    // Match orphaned messages where from_address or to_addresses contains this
    // email. Detect matches via count, not a .select() read-back — the update
    // writes the matched_contact_id column the filter tests, the rule-17 shape
    // (CAR-139).
    const { count: matchedFrom, error: fromError } = await supabase
      .from("email_messages")
      .update({ matched_contact_id: contactId }, { count: "exact" })
      .eq("user_id", userId)
      .is("matched_contact_id", null)
      .eq("from_address", email);
    if (fromError) { console.error("Backfill claim error (from):", fromError); passFailed = true; }

    const { count: matchedTo, error: toError } = await supabase
      .from("email_messages")
      .update({ matched_contact_id: contactId }, { count: "exact" })
      .eq("user_id", userId)
      .is("matched_contact_id", null)
      .contains("to_addresses", [email]);
    if (toError) { console.error("Backfill claim error (to):", toError); passFailed = true; }

    totalMatched += (matchedFrom || 0) + (matchedTo || 0);
  }

  // Junction pass: collect ids of ALL matching messages (paginated — a single
  // PostgREST read caps at 1000 rows) and link them idempotently.
  const linkIds = new Set<number>();
  const PAGE = 1000;
  for (const email of lowerEmails) {
    for (const leg of ["from", "to"] as const) {
      let offset = 0;
      for (;;) {
        let q = supabase
          .from("email_messages")
          .select("id")
          .eq("user_id", userId)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        q = leg === "from" ? q.eq("from_address", email) : q.contains("to_addresses", [email]);
        const { data, error } = await q;
        if (error) {
          console.error("Backfill junction id lookup error:", error);
          passFailed = true;
          break;
        }
        for (const r of data ?? []) linkIds.add(r.id);
        if (!data || data.length < PAGE) break;
        offset += PAGE;
      }
    }
  }

  if (linkIds.size > 0) {
    const linkRows = [...linkIds].map((id) => ({ email_message_id: id, contact_id: contactId }));
    for (let i = 0; i < linkRows.length; i += 500) {
      const { error: linkError } = await supabase
        .from("email_message_contacts")
        .upsert(linkRows.slice(i, i + 500), {
          onConflict: "email_message_id,contact_id",
          ignoreDuplicates: true,
        });
      if (linkError) { console.error("Backfill junction link error:", linkError); passFailed = true; }
    }
  }

  // Completion stamp, mirroring the sync watermark contract: only a pass with
  // no swallowed failures records itself, so the next call retries a partial
  // one. CAS-guarded on the value read at the gate — a concurrent address-add
  // fires the reset trigger (email_backfilled_at → NULL), and this in-flight
  // pass, which scanned the OLD address set, must not overwrite that reset or
  // the new address would sit invisible for a full staleness window. No
  // readback: losing the CAS just means the next call re-runs (idempotent).
  if (!passFailed) {
    let stamp = supabase
      .from("contacts")
      .update({ email_backfilled_at: backfillStartedAt.toISOString() })
      .eq("id", contactId);
    stamp = backfilledAt === null
      ? stamp.is("email_backfilled_at", null)
      : stamp.eq("email_backfilled_at", backfilledAt);
    const { error: stampError } = await stamp;
    if (stampError) {
      console.error(`Failed to stamp email backfill for contact ${contactId}:`, stampError);
    }
  }

  return totalMatched;
}

/** Fetch the full body of a single Gmail message (HTML preferred, plaintext fallback). */
export async function getFullMessage(
  userId: string,
  gmailMessageId: string
): Promise<{ subject: string; from: string; to: string; date: string; bodyHtml: string | null; bodyText: string | null; messageId: string; gmailMessageId: string; threadId: string }> {
  const gmail = await getGmailClient(userId);

  const res = await gmail.users.messages.get({
    userId: "me",
    id: gmailMessageId,
    format: "full",
  });

  const headers = (res.data.payload?.headers || []) as ParsedHeader[];
  const subject = getHeader(headers, "Subject");
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const date = getHeader(headers, "Date");
  const messageId = getHeader(headers, "Message-ID") || getHeader(headers, "Message-Id");
  const threadId = res.data.threadId || "";

  let bodyHtml: string | null = null;
  let bodyText: string | null = null;

  function extractParts(payload: typeof res.data.payload) {
    if (!payload) return;

    if (payload.mimeType === "text/html" && payload.body?.data) {
      bodyHtml = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      bodyText = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        extractParts(part as typeof payload);
      }
    }
  }

  extractParts(res.data.payload);

  return { subject, from, to, date, bodyHtml, bodyText, messageId, gmailMessageId, threadId };
}

/**
 * Mark a Gmail message as read by updating the local cache first,
 * then removing the UNREAD label in Gmail (best-effort).
 * DB is updated first so the read status persists even if the
 * Gmail API call fails (e.g. token refresh error, rate limit).
 */
export async function markMessageAsRead(userId: string, gmailMessageId: string) {
  // Update local DB first — this is the source of truth for the UI
  const supabase = createSupabaseServiceClient();
  const { error: dbError } = await supabase
    .from("email_messages")
    .update({ is_read: true })
    .eq("user_id", userId)
    .eq("gmail_message_id", gmailMessageId);

  if (dbError) {
    console.error("Failed to update is_read in DB:", dbError);
  }

  // Then sync with Gmail (best-effort — don't let failures undo the local state)
  try {
    const gmail = await getGmailClient(userId);
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  } catch (gmailError) {
    console.error("Failed to remove UNREAD label in Gmail:", gmailError);
  }
}

/**
 * List all Gmail labels for a user (used for "Move to folder" UI).
 * Filters out internal/system labels that aren't useful to display.
 */
export async function getGmailLabels(userId: string) {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = (res.data.labels || []).map((l) => ({
    id: l.id!,
    name: l.name!,
    type: l.type || "user",
  }));

  const visibleSystem = new Set([
    "IMPORTANT",
    "STARRED",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
  ]);

  return labels.filter(
    (l) => l.type === "user" || visibleSystem.has(l.id)
  );
}

/**
 * Move a message to a Gmail label/folder by adding the target label
 * and removing INBOX. Also deletes the local cache row so it
 * disappears from the webapp.
 */
export async function moveMessageToLabel(
  userId: string,
  gmailMessageId: string,
  labelId: string
) {
  const gmail = await getGmailClient(userId);

  await gmail.users.messages.modify({
    userId: "me",
    id: gmailMessageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ["INBOX"],
    },
  });

  const supabase = createSupabaseServiceClient();
  await supabase
    .from("email_messages")
    .delete()
    .eq("user_id", userId)
    .eq("gmail_message_id", gmailMessageId);
}

/**
 * Trash a message in Gmail and mark it as trashed in the local cache.
 */
export async function trashMessage(userId: string, gmailMessageId: string) {
  const gmail = await getGmailClient(userId);
  await gmail.users.messages.trash({ userId: "me", id: gmailMessageId });

  const supabase = createSupabaseServiceClient();
  await supabase
    .from("email_messages")
    .update({ is_trashed: true })
    .eq("user_id", userId)
    .eq("gmail_message_id", gmailMessageId);
}

/**
 * Untrash (restore) a message in Gmail and the local cache.
 */
export async function untrashMessage(userId: string, gmailMessageId: string) {
  const gmail = await getGmailClient(userId);
  await gmail.users.messages.untrash({ userId: "me", id: gmailMessageId });

  const supabase = createSupabaseServiceClient();
  await supabase
    .from("email_messages")
    .update({ is_trashed: false })
    .eq("user_id", userId)
    .eq("gmail_message_id", gmailMessageId);
}

// ── Follow-up scheduling helpers ──

/**
 * Check if a thread has received any inbound reply since a given date.
 * Used before sending follow-ups to auto-cancel if the recipient responded.
 */
export async function checkForReplyInThread(
  userId: string,
  threadId: string,
  sinceDate: string
): Promise<boolean> {
  const supabase = createSupabaseServiceClient();

  // First check cached messages
  const cached = must(
    await supabase
      .from("email_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .gte("date", sinceDate)
      .limit(1),
  );

  if (cached && cached.length > 0) return true;

  // Also do a live check against Gmail API for freshness
  try {
    const gmail = await getGmailClient(userId);
    const conn = await getConnection(userId);
    if (!conn) return false;

    const res = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From"],
    });

    const messages = res.data.messages || [];
    const sinceTime = new Date(sinceDate).getTime();
    // Alias-aware self-filter (CAR-153/R2.5): a message the user sent from a
    // send-as alias must not read as the contact replying.
    const ownAddressSet = buildOwnAddressSet(conn.gmail_address, conn.send_as_aliases);

    for (const msg of messages) {
      const headers = (msg.payload?.headers || []) as ParsedHeader[];
      const from = getHeader(headers, "From");
      const fromAddr = parseEmailAddress(from);
      const msgDate = Number(msg.internalDate || 0);
      // An NDR in the thread is a delivery failure, not the contact replying
      // — detectBounces owns those (cancelled_bounce, bounced_at).
      if (!ownAddressSet.has(fromAddr) && !isBounceSenderAddress(fromAddr) && msgDate >= sinceTime) {
        return true;
      }
    }
  } catch (err) {
    console.error("Error checking thread for replies:", err);
  }

  return false;
}

/**
 * Process all pending follow-up messages that are due.
 * For each due message:
 *   1. Check if the thread has received a reply → cancel the sequence
 *   2. If no reply, send the follow-up email
 *   3. Update statuses accordingly
 */
/**
 * Graduate a prospect/bench contact into the active network after they
 * reply, when the caller only knows the recipient email address (the
 * follow-up sequence tables don't store contact_id). No-op if the email
 * doesn't match one of the user's contacts or they're already active.
 */
export async function activateContactByEmail(userId: string, email: string) {
  const supabase = createSupabaseServiceClient();
  // contact_emails.email is normalized to lower(trim()) by a DB trigger
  // (CAR-153/R2.8), so an exact match on the lowercased input replaces the
  // old unescaped ILIKE (whose _ and % wildcards could cross-match).
  // Activate EVERY matching contact: with a limit(1) and no order-by, two
  // contacts sharing the address made the row choice arbitrary, and the
  // reply could land on the already-active twin while the prospect never
  // graduated.
  const { data, error } = await supabase
    .from("contact_emails")
    .select("contact_id, contacts!inner(user_id)")
    .eq("email", email.toLowerCase().trim())
    .eq("contacts.user_id", userId);
  if (error || !data || data.length === 0) return;

  const contactIds = [...new Set(data.map((r) => r.contact_id).filter((id): id is number => id != null))];
  if (contactIds.length === 0) return;

  // Inline user_id scoping (CAR-151), matching the sibling activation above:
  // contactIds come from the user-scoped read, but that read's tenancy rests
  // on its contacts!inner embed, and dropping an !inner is an edit no
  // typecheck or lint catches. The write carries its own scope.
  const { error: actError } = await supabase
    .from("contacts")
    .update({ network_status: "active" })
    .in("id", contactIds)
    .eq("user_id", userId)
    .in("network_status", ["prospect", "bench"]);
  if (actError) console.error("Failed to activate contact on reply:", actError);
}

/**
 * Create a real Gmail draft (users.drafts.create). The granted
 * gmail.modify scope covers drafts — no extra consent needed.
 * Returns ids plus a deep link to the drafts folder.
 */
export async function createDraft(
  userId: string,
  opts: ComposeEmailOptions
): Promise<{ draftId: string; messageId: string; threadId: string; webUrl: string }> {
  const gmail = await getGmailClient(userId);
  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const raw = buildMimeMessage(conn.gmail_address, opts);

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      },
    },
  });

  const messageId = res.data.message?.id || "";
  return {
    draftId: res.data.id || "",
    messageId,
    threadId: res.data.message?.threadId || "",
    webUrl: "https://mail.google.com/mail/u/0/#drafts",
  };
}

/**
 * Process all pending scheduled emails that are due.
 * After sending each, update any follow-up sequences linked to the scheduled email
 * with the real Gmail message ID and thread ID.
 */
export async function processScheduledEmails(
  userId: string,
  // Injected for tests only — production callers pass nothing.
  deps: {
    service?: ReturnType<typeof createSupabaseServiceClient>;
    send?: typeof sendTrackedEmail;
  } = {},
): Promise<{
  sent: number;
  errors: number;
}> {
  const supabase = deps.service ?? createSupabaseServiceClient();
  const send = deps.send ?? sendTrackedEmail;
  const now = new Date().toISOString();

  // Paginated (CAR-223): this is the sole driver for scheduled sends, so a
  // truncated read does not degrade a view — it means mail the user queued is
  // never dispatched at all, silently.
  const pending = await paginateAll(async (from, to) =>
    must(
      await supabase
        .from("scheduled_emails")
        .select("*")
        .eq("user_id", userId)
        .eq("status", ScheduledEmailStatus.Pending)
        .lte("scheduled_send_at", now)
        .order("scheduled_send_at", { ascending: true })
        .order("id")
        .range(from, to),
    ),
  );

  if (pending.length === 0) return { sent: 0, errors: 0 };

  let sent = 0;
  let errors = 0;

  for (const email of pending) {
    // Atomic claim (CAR-134). Two independent drivers call this: the A1 send
    // watcher, which pokes the send route within ~15s of a row coming due, and
    // QStash hourly behind it as a safety net (CAR-215). Either can start a run
    // while the other is mid-flight, and the race window is the whole Gmail
    // round trip. Flip pending → sending first; whoever loses the CAS skips the
    // row. (CAR-139 had removed the page-load process triggers, leaving the
    // cron as the only driver; CAR-215 added the watcher beside it.)
    // count, not .select() — the update writes the column the filter tests, so
    // a returning-representation read comes back empty on success (rule 17).
    const { count: claimed } = await supabase
      .from("scheduled_emails")
      .update(
        { status: ScheduledEmailStatus.Sending, claimed_at: now, updated_at: now },
        { count: "exact" },
      )
      .eq("id", email.id)
      .eq("status", ScheduledEmailStatus.Pending);
    if (claimed !== 1) continue;

    // Release the claim so a later tick retries. Guarded on 'sending' as
    // belt-and-braces against overwriting a concurrent status change.
    const releaseClaim = async () => {
      await supabase
        .from("scheduled_emails")
        .update({ status: ScheduledEmailStatus.Pending, claimed_at: null, updated_at: new Date().toISOString() })
        .eq("id", email.id)
        .eq("status", ScheduledEmailStatus.Sending);
    };

    // Once send() has resolved, Gmail has the message and the claim must never
    // be released — a released claim re-enters the pending pool and the next
    // tick delivers a duplicate (CAR-179).
    let delivered = false;

    try {
      // Route through the shared tracked path so scheduled sends count against
      // the daily cap, are refused if the address has since bounced, and get
      // cached + interaction-logged like interactive sends.
      let result: { messageId: string; threadId: string };
      try {
        result = await send(
          userId,
          {
            to: email.recipient_email,
            cc: email.cc || undefined,
            bcc: email.bcc || undefined,
            subject: email.subject,
            bodyHtml: email.body_html,
            threadId: email.thread_id || undefined,
            inReplyTo: email.in_reply_to || undefined,
            references: email.references_header || undefined,
          },
          { isScheduled: true },
        );
      } catch (policyErr) {
        if (policyErr instanceof SendPolicyError) {
          // Cap reached (429) → stop the batch, retry next run.
          //
          // Bounce (422) → leave pending. The row is not stranded by that:
          // detectBounces cancels pending rows to a bounced address, and it is
          // the same pass that set the bounced_at this refusal reads. Until
          // CAR-220 it only cancelled follow-up sequences and never touched
          // this table, so this comment described a cancellation that did not
          // exist and the row was re-claimed and re-refused on every tick,
          // forever. Timing, stated rather than implied: detectBounces runs at
          // the end of a COMPLETED /api/gmail/sync pass, and that pass is driven
          // from the app (inbox load, settings), so the cancel lands on the
          // user's next full sync rather than within seconds of the NDR.
          console.warn(`[scheduled] ${email.id} deferred: ${policyErr.message}`);
          await releaseClaim();
          if (policyErr.status === 429) break;
          continue;
        }
        throw policyErr;
      }
      delivered = true;

      // Mark as sent. Guarded on the claim so nothing else gets overwritten;
      // if this write is never reached (process killed mid-send), the row
      // stays 'sending' and the cron sweeper flags it 'failed' rather than
      // re-sending — the email may already be out.
      await supabase
        .from("scheduled_emails")
        .update({
          status: ScheduledEmailStatus.Sent,
          sent_at: now,
          gmail_message_id: result.messageId,
          sent_thread_id: result.threadId,
          updated_at: now,
        })
        .eq("id", email.id)
        .eq("status", ScheduledEmailStatus.Sending);

      // Back-fill the sequences that were waiting on this send: until now they
      // carried no thread, which is what kept them dormant (the follow-up cron
      // filters on `thread_id is not null`). Stamping the real ids is what
      // releases them.
      //
      // Scoped on BOTH user and status, neither of which the link alone
      // implies. user_id because this is a service-role write and carries no
      // tenant scope of its own (CAR-151) — every other write in this file
      // states it. Status because a sequence can be retired BEFORE its opening
      // email sends: detectBounces cancels by recipient address, which matches
      // a pre-send sequence fine. Stamping a cancelled row would not resurrect
      // it (status is untouched), but it would rewrite the record of a sequence
      // that never ran, and 'active' is the only state the stamp is FOR.
      await supabase
        .from("email_follow_ups")
        .update({
          original_gmail_message_id: result.messageId,
          thread_id: result.threadId,
          original_sent_at: now,
          updated_at: now,
        })
        .eq("scheduled_email_id", email.id)
        .eq("user_id", userId)
        .eq("status", FollowUpStatus.Active);

      sent++;
    } catch (err) {
      console.error(`Error sending scheduled email ${email.id}:`, err);
      if (delivered) {
        // Post-send failure: the email is out, only the bookkeeping writes
        // (mark-sent / follow-up linking) failed. Leave the row 'sending' so
        // the stale-claim sweeper flags it 'failed' for manual reconciliation
        // — the same terminal path as a process killed mid-send. Releasing
        // here would re-queue an already-delivered email and the next tick
        // would send a duplicate (CAR-179).
        console.error(
          `[scheduled] ${email.id} delivered but mark-sent failed; leaving claim for the sweeper`,
        );
      } else {
        // Pre-send failure: nothing was delivered, so release the claim and
        // let the next tick retry.
        await releaseClaim();
      }
      errors++;
    }
  }

  return { sent, errors };
}

/** How far back the thread-reply sweep looks, and its page ceiling. */
const THREAD_REPLY_WINDOW_DAYS = 30;
const THREAD_REPLY_MAX_PAGES = 20;

/**
 * Ingest messages on threads we already track that the per-contact sync is
 * structurally unable to see (CAR-227).
 *
 * syncEmailsForContact queries Gmail by a contact's KNOWN addresses
 * (`from:x OR to:x`), so a reply sent from any OTHER address is invisible to
 * it — however plainly it belongs to a thread we already hold. That is not an
 * edge case for this product: outreach routinely goes to a scraped or
 * pattern-guessed address that routes to the person, and they answer from
 * their real one. Measured live: mail to smita.verma@adobe.com was answered
 * from smiverma@adobe.com, and both replies stayed invisible while the thread
 * sat in the inbox looking unanswered.
 *
 * The follow-up cron already reads WHOLE THREADS for exactly this reason
 * (send-follow-ups/route.ts), so a sequence would correctly cancel on such a
 * reply while the message itself never reached the inbox, the contact
 * timeline, stage derivation, or the reply_received event. The two paths
 * disagreed about whether the contact had replied.
 *
 * Shaped like detectBounces below, which exists for the same class of blind
 * spot: one mailbox-wide query per completed pass, filtered against what we
 * already know, rather than a per-contact call. Cost is bounded by the time
 * window rather than by thread count — messages.list returns threadId, so
 * unrelated mail is discarded without ever costing a metadata fetch.
 */
export async function syncThreadReplies(
  userId: string,
  opts: { sinceDays?: number } = {},
): Promise<{ ingested: number; learnedAddresses: number }> {
  const supabase = createSupabaseServiceClient();
  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const ownAddresses = buildOwnAddressSet(conn.gmail_address, conn.send_as_aliases);
  const sinceDays = opts.sinceDays ?? THREAD_REPLY_WINDOW_DAYS;
  const afterEpoch = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);

  // Every thread we hold, and every message id already in it. Deliberately NOT
  // date-filtered: a thread whose last message predates the window is exactly
  // the one a late reply lands on, and filtering it out would reintroduce the
  // blind spot this function exists to close.
  const knownRows = await paginateAll(async (from, to) =>
    must(
      await supabase
        .from("email_messages")
        .select("gmail_message_id, thread_id, matched_contact_id, email_message_contacts(contact_id)")
        .eq("user_id", userId)
        .not("thread_id", "is", null)
        .order("id")
        .range(from, to),
    ),
  );

  const knownMessageIds = new Set<string>();
  const contactsByThread = new Map<string, Set<number>>();
  for (const row of knownRows) {
    knownMessageIds.add(row.gmail_message_id);
    const threadId = row.thread_id as string;
    let linked = contactsByThread.get(threadId);
    if (!linked) {
      linked = new Set<number>();
      contactsByThread.set(threadId, linked);
    }
    if (row.matched_contact_id != null) linked.add(row.matched_contact_id);
    for (const l of row.email_message_contacts ?? []) {
      if (l.contact_id != null) linked.add(l.contact_id);
    }
  }
  if (contactsByThread.size === 0) return { ingested: 0, learnedAddresses: 0 };

  const gmail = await getGmailClient(userId);

  // One untargeted list per page: the filter is threadId membership, which the
  // list response already carries, so an unrelated newsletter costs nothing
  // beyond the page it rode in on.
  const candidateIds: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const listRes = await withRetry(() =>
      gmail.users.messages.list({
        userId: "me",
        q: `after:${afterEpoch}`,
        maxResults: 100,
        pageToken,
      }),
    );
    for (const m of listRes.data.messages || []) {
      if (!m.id || !m.threadId) continue;
      if (knownMessageIds.has(m.id)) continue;
      if (!contactsByThread.has(m.threadId)) continue;
      candidateIds.push(m.id);
    }
    pageToken = listRes.data.nextPageToken || undefined;
    pages++;
  } while (pageToken && pages < THREAD_REPLY_MAX_PAGES);

  if (candidateIds.length === 0) return { ingested: 0, learnedAddresses: 0 };

  let ingested = 0;
  let learnedAddresses = 0;
  // Threads this sweep newly saw a reply on (CAR-233). Accumulated across the
  // batches and drained once at the end, so a user with replies on ten threads
  // pays one cancel pass rather than ten.
  const repliedThreadIds = new Set<string>();

  for (let i = 0; i < candidateIds.length; i += 20) {
    const batch = candidateIds.slice(i, i + 20);
    const details = await Promise.all(
      batch.map((id) =>
        withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          }),
        ),
      ),
    );

    for (const res of details) {
      const msg = res.data;
      if (!msg.id || !msg.threadId) continue;
      const linked = contactsByThread.get(msg.threadId);
      if (!linked || linked.size === 0) continue;

      const headers = (msg.payload?.headers || []) as ParsedHeader[];
      const fromAddr = parseEmailAddress(getHeader(headers, "From"));
      const toAddrs = getHeader(headers, "To").split(",").map(parseEmailAddress).filter(Boolean);
      const isOutbound = ownAddresses.has(fromAddr);
      // An NDR sitting in a tracked thread is a delivery failure, not a reply.
      // detectBounces owns it; ingesting it as inbound would activate the very
      // contact whose address just failed.
      if (!isOutbound && isBounceSenderAddress(fromAddr)) continue;

      const rawDate = getHeader(headers, "Date");
      const parsedDate = rawDate ? new Date(rawDate) : null;
      const primaryContactId = [...linked][0];

      const { data: inserted, error: insertError } = await supabase
        .from("email_messages")
        .upsert(
          {
            user_id: userId,
            gmail_message_id: msg.id,
            thread_id: msg.threadId,
            subject: getHeader(headers, "Subject") || null,
            snippet: msg.snippet || null,
            from_address: fromAddr,
            to_addresses: toAddrs,
            date: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
            label_ids: msg.labelIds || [],
            is_read: !(msg.labelIds || []).includes("UNREAD"),
            direction: isOutbound ? EmailDirection.Outbound : EmailDirection.Inbound,
            matched_contact_id: primaryContactId,
          },
          { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true },
        )
        .select("id, direction");
      if (insertError) {
        console.error("[threadReplies] insert failed:", insertError);
        continue;
      }
      // ignoreDuplicates makes this ON CONFLICT DO NOTHING, so an empty
      // RETURNING means a concurrent sync already claimed the row. Skipping
      // keeps the side effects below firing exactly once (CAR-58's contract).
      const row = (inserted ?? [])[0];
      if (!row) continue;
      ingested++;

      // Attribute to every contact the thread is already linked to — the same
      // union the inbox reads from (CAR-159/CAR-169).
      const { error: linkError } = await supabase
        .from("email_message_contacts")
        .upsert(
          [...linked].map((contactId) => ({ email_message_id: row.id, contact_id: contactId })),
          { onConflict: "email_message_id,contact_id", ignoreDuplicates: true },
        );
      if (linkError) console.error("[threadReplies] junction link failed:", linkError);

      if (isOutbound) continue;

      // Past the outbound guard and the NDR skip above, this row IS a reply.
      repliedThreadIds.add(msg.threadId);

      // Learn the address they actually write from (CAR-227). Without this the
      // next sync is blind to this thread all over again, AND a reply Dawson
      // sends to it caches with matched_contact_id null, detaching his own
      // message from the contact's timeline. Only when the thread resolves to
      // exactly ONE tracked contact: on a shared thread the sender is
      // genuinely ambiguous, and a wrong row here would misroute future mail.
      if (linked.size === 1 && fromAddr) {
        const existing = must(
          await supabase
            .from("contact_emails")
            .select("id")
            .eq("contact_id", primaryContactId)
            .eq("email", fromAddr)
            .maybeSingle(),
        );
        if (!existing) {
          // 'verified', the top of the source ladder: they demonstrably own it,
          // having written to us from it. Never primary — the address the user
          // has been successfully reaching them on keeps that.
          const { error: learnError } = await supabase
            .from("contact_emails")
            .insert({ contact_id: primaryContactId, email: fromAddr, is_primary: false, source: "verified" });
          if (learnError) console.error("[threadReplies] address learn failed:", learnError);
          else learnedAddresses++;
        }
      }

      // A reply is what graduates an imported prospect into the active network,
      // and the per-contact sync fires this on its own inserts. Inline user_id
      // scoping: a service-role write carries no tenant scope of its own.
      const { error: activateError } = await supabase
        .from("contacts")
        .update({ network_status: "active" })
        .eq("id", primaryContactId)
        .eq("user_id", userId)
        .in("network_status", ["prospect", "bench"]);
      if (activateError) console.error("[threadReplies] activate failed:", activateError);

      // CAR-38 north-star event, on the same thread-attributed terms the
      // per-contact sync uses: a reply counts only where we had sent first.
      const priorOutbound = must(
        await supabase
          .from("email_messages")
          .select("ai_assisted")
          .eq("user_id", userId)
          .eq("thread_id", msg.threadId)
          .eq("direction", EmailDirection.Outbound)
          .limit(1)
          .maybeSingle(),
      );
      if (priorOutbound) {
        await trackServer(userId, "reply_received", {
          ai_assisted: priorOutbound.ai_assisted === true,
        });
      }
    }
  }

  // CAR-233: retire the sequences these replies answered, now rather than at
  // the send cron's next tick. This sweep is the ONLY path that sees a reply
  // sent from an address the contact record doesn't carry (CAR-227), so without
  // it those sequences keep nagging until a step comes due. Error-tolerated for
  // the same reason it is on the per-contact path: the send-time check backstops
  // it, and the caller already treats this whole sweep as best-effort.
  if (repliedThreadIds.size > 0) {
    try {
      await cancelFollowUpsForRepliedThreads(supabase, userId, repliedThreadIds);
    } catch (err) {
      console.error("[threadReplies] follow-up cancel failed:", err);
    }
  }

  return { ingested, learnedAddresses };
}

/**
 * One `contact_emails` row joined to its owning contact, as detectBounces reads
 * it. Declared rather than inferred because the embed's shape (object vs array)
 * depends on how the relationship is resolved, and the alert needs the name.
 */
interface BounceEmailRow {
  id: number;
  contact_id: number | null;
  bounced_at: string | null;
  contacts: { user_id: string; name: string | null } | null;
}

/**
 * Bounce detection (plan 24 Phase 4; hardened and completed by CAR-217).
 *
 * NDRs arrive from mailer-daemon/postmaster and never match a contact by
 * address, so the per-contact sync can't see them. This pass queries Gmail for
 * recent NDRs, extracts the permanently-failed recipients, then:
 *   1. sets contact_emails.bounced_at for the failed address,
 *   2. cancels active follow-up sequences to that address — sequences otherwise
 *      auto-cancel only on reply and would fire steps 2-3 into the void and burn
 *      sender reputation,
 *   3. cancels PENDING scheduled emails to it. Without this they are never
 *      resolved: sendTrackedEmail refuses the recipient with a 422 and
 *      processScheduledEmails defers, so the row is retried on every tick
 *      forever. Deliberately not 'sending' rows, which are a live claim held by
 *      a send driver mid-Gmail-round-trip and belong to the stale-claim sweeper.
 *   4. emails the user, once per pass, about addresses that JUST died.
 *
 * Which recipients count as failed is `@/lib/bounce-parse`, which is where the
 * delay-versus-failure and RFC 3464 handling lives and is unit-tested. Read that
 * header before touching detection: marking an address is destructive, so the
 * parse is deliberately biased toward extracting nothing when unsure.
 *
 * Idempotent: bounced_at is only set once, and the notification fires on the
 * null -> bounced TRANSITION, so re-running is safe and does not re-notify.
 *
 * Requires a Gmail read scope, so this is premium-only in practice — a free
 * connection holds gmail.send alone and cannot list these messages at all. See
 * the CAR-217 plan for why the consequences (the contact-page flag, the send
 * refusal, the cancellations) stay ungated even though detection cannot be.
 *
 * Contact-scoped by design: an address this user has no contact row for is
 * skipped entirely. bounced_at cannot be recorded for it, so nothing downstream
 * refuses it and nothing is poisoned.
 */
export async function detectBounces(
  userId: string,
  sinceDays = 14
): Promise<{
  bounced: string[];
  cancelledSequences: number;
  cancelledScheduled: number;
  /** Addresses that transitioned to bounced on THIS pass (drives the alert). */
  newlyBounced: string[];
  alert: BounceAlertOutcome;
}> {
  const gmail = await getGmailClient(userId);
  const supabase = createSupabaseServiceClient();
  const afterEpoch = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);

  const empty = {
    bounced: [] as string[],
    cancelledSequences: 0,
    cancelledScheduled: 0,
    newlyBounced: [] as string[],
    alert: "no_items" as BounceAlertOutcome,
  };

  const listRes = await withRetry(() =>
    gmail.users.messages.list({
      userId: "me",
      q: `from:(mailer-daemon OR postmaster OR "Mail Delivery Subsystem") after:${afterEpoch}`,
      maxResults: 50,
    })
  );

  const messageIds = (listRes.data.messages || []).map((m) => m.id!);
  if (messageIds.length === 0) return empty;

  // Two-phase fetch. The metadata pass is cheap and resolves the common Gmail
  // bounce from its X-Failed-Recipients header; only messages that pass leaves
  // unresolved pay for a `full` fetch to reach the delivery-status part. Before
  // CAR-217 there was no second phase, so every NDR without that header (any
  // bounce generated by the recipient's own MTA) was silently dropped.
  const failedAddresses = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 10) {
    const batch = messageIds.slice(i, i + 10);
    const details = await Promise.all(
      batch.map((id) =>
        withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["X-Failed-Recipients", "Subject"],
          })
        )
      )
    );

    const needFull: string[] = [];
    for (let j = 0; j < details.length; j++) {
      const headers = (details[j].data.payload?.headers || []) as ParsedHeader[];
      if (needsFullFetch(headers)) {
        needFull.push(batch[j]);
        continue;
      }
      for (const addr of extractFailedRecipients({ headers }).addresses) {
        failedAddresses.add(addr);
      }
    }

    if (needFull.length > 0) {
      const fullDetails = await Promise.all(
        needFull.map((id) =>
          withRetry(() => gmail.users.messages.get({ userId: "me", id, format: "full" }))
        )
      );
      for (const res of fullDetails) {
        const headers = (res.data.payload?.headers || []) as ParsedHeader[];
        const verdict = extractFailedRecipients({ headers, payload: res.data.payload });
        for (const addr of verdict.addresses) failedAddresses.add(addr);
      }
    }
  }

  if (failedAddresses.size === 0) return empty;

  const now = new Date().toISOString();
  const bounced: string[] = [];
  const newlyBounced: string[] = [];
  const alertItems: BounceAlertItem[] = [];
  let cancelledSequences = 0;
  let cancelledScheduled = 0;

  // Pending scheduled emails for this user, indexed by normalized recipient.
  // Read once for the whole pass rather than per address.
  //
  // Matched in JS rather than with a filter because recipient_email is stored
  // exactly as the user typed it — scheduled_emails has no normalizing trigger,
  // unlike contact_emails — so `.eq` on the lowercased NDR address misses
  // "John.Doe@X.com". `.ilike` is not the fix: `_` and `%` are legal characters
  // in a local part and would silently match other people's addresses.
  // Paginated (CAR-223): a truncated read here leaves queued mail to a dead
  // address uncancelled, which is the exact harm this whole path exists to
  // prevent.
  const pendingScheduled = await paginateAll(async (from, to) =>
    must(
      await supabase
        .from("scheduled_emails")
        .select("id, recipient_email")
        .eq("user_id", userId)
        .eq("status", ScheduledEmailStatus.Pending)
        .order("id")
        .range(from, to),
    ),
  );
  const scheduledByRecipient = new Map<string, number[]>();
  for (const row of pendingScheduled ?? []) {
    const key = (row.recipient_email ?? "").trim().toLowerCase();
    if (!key) continue;
    const ids = scheduledByRecipient.get(key);
    if (ids) ids.push(row.id);
    else scheduledByRecipient.set(key, [row.id]);
  }

  for (const address of failedAddresses) {
    // Only touch addresses that belong to this user's contacts
    const emailRows = must(
      await supabase
        .from("contact_emails")
        .select("id, contact_id, bounced_at, contacts!inner(user_id, name)")
        .eq("email", address)
        .eq("contacts.user_id", userId),
    );
    if (!emailRows || emailRows.length === 0) continue;

    bounced.push(address);
    const unmarked = (emailRows as BounceEmailRow[]).filter((r) => !r.bounced_at);
    if (unmarked.length > 0) {
      await supabase
        .from("contact_emails")
        .update({ bounced_at: now })
        .in("id", unmarked.map((r) => r.id));
    }

    // Cancel active follow-up sequences aimed at the dead address
    const sequences = must(
      await supabase
        .from("email_follow_ups")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "active")
        .eq("recipient_email", address),
    );
    let sequencesForAddress = 0;
    for (const seq of sequences || []) {
      await supabase
        .from("email_follow_ups")
        .update({ status: FollowUpStatus.CancelledBounce, updated_at: now })
        .eq("id", seq.id)
        .eq("user_id", userId);
      await supabase
        .from("email_follow_up_messages")
        .update({ status: FollowUpMessageStatus.Cancelled })
        .eq("follow_up_id", seq.id)
        .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
      sequencesForAddress++;
    }
    cancelledSequences += sequencesForAddress;

    // Cancel queued scheduled mail to the dead address.
    //
    // Keyed on ids from the normalized index above rather than a filter on the
    // address. CAR-217 filtered `.eq("to_email", address)`, and that column does
    // not exist — it is `recipient_email`. postgrest-js types `eq` as
    // `ColumnName extends string`, so tsc could not catch it, and the unit
    // fixtures seeded `to_email` too, so the tests passed while production
    // returned 42703 and cancelled nothing. Matching in JS also handles the
    // casing problem: recipient_email is stored as the user typed it (no
    // normalizing trigger, unlike contact_emails), so `.eq` on a lowercased NDR
    // address misses "John.Doe@X.com", and `.ilike` is not the fix because `_`
    // and `%` are legal in a local part.
    //
    // Only PENDING: a 'sending' row is a live claim held mid-Gmail-round-trip
    // and belongs to the stale-claim sweeper. The filter is re-asserted on the
    // write so a row claimed between the read and here is left alone, and
    // count (not .select()) is the success signal because the update writes the
    // column the filter tests (rule 17).
    const poisoned = scheduledByRecipient.get(address) ?? [];
    let scheduledForAddress = 0;
    if (poisoned.length > 0) {
      const { count: scheduledCancelled, error: scheduledError } = await supabase
        .from("scheduled_emails")
        .update(
          { status: ScheduledEmailStatus.Cancelled, updated_at: now },
          { count: "exact" },
        )
        .in("id", poisoned)
        .eq("status", ScheduledEmailStatus.Pending);
      if (scheduledError) {
        console.error(`[bounce] failed to cancel scheduled mail to ${address}:`, scheduledError);
      } else {
        scheduledForAddress = scheduledCancelled ?? 0;
      }
    }
    cancelledScheduled += scheduledForAddress;

    // The alert covers the transition only. An address re-detected on a later
    // pass is already known and already flagged in the UI; re-emailing about it
    // every run would train the user to ignore the alert entirely.
    if (unmarked.length > 0) {
      newlyBounced.push(address);
      const contact = unmarked[0].contacts;
      alertItems.push({
        contactName: contact?.name || address,
        address,
        contactId: unmarked[0].contact_id ?? null,
        cancelledFollowUps: sequencesForAddress,
        cancelledScheduled: scheduledForAddress,
      });
    }

  }

  const alert = await sendBounceAlert(userId, alertItems, { nowIso: now });

  return { bounced, cancelledSequences, cancelledScheduled, newlyBounced, alert };
}
