/**
 * Gmail API service module
 *
 * Handles OAuth token management, email fetching, and contact-based sync.
 * Tokens are stored in the gmail_connections table via the service client
 * (bypasses RLS so API routes can read/write tokens server-side).
 */

import { google } from "googleapis";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus, UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES } from "@/lib/constants";

/** Retry a function with exponential backoff on rate-limit (429) or server errors (5xx). */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.code || err?.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
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

/** Load tokens from DB, refresh if expired, return an authenticated Gmail client. */
export async function getGmailClient(userId: string) {
  const supabase = createSupabaseServiceClient();

  const { data: conn, error } = await supabase
    .from("gmail_connections")
    .select("access_token, refresh_token, token_expires_at, gmail_address")
    .eq("user_id", userId)
    .single();

  if (error || !conn) throw new Error("Gmail not connected");

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: decryptOAuthToken(conn.access_token),
    refresh_token: decryptOAuthToken(conn.refresh_token),
    expiry_date: new Date(conn.token_expires_at).getTime(),
  });

  await refreshTokenIfNeeded(supabase, oauth2Client, userId, new Date(conn.token_expires_at).getTime(), "Gmail");

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/** Get the gmail connection row for a user (or null). */
export async function getConnection(userId: string) {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("gmail_connections")
    .select("id, gmail_address, last_gmail_sync_at, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

/** Revoke Google token and delete all Gmail data for a user. */
export async function revokeAccess(userId: string) {
  const supabase = createSupabaseServiceClient();

  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("access_token")
    .eq("user_id", userId)
    .single();

  if (conn?.access_token) {
    try {
      const oauth2Client = getOAuth2Client();
      await oauth2Client.revokeToken(decryptOAuthToken(conn.access_token));
    } catch {
      // Token may already be invalid — continue with cleanup
    }
  }

  await supabase.from("email_messages").delete().eq("user_id", userId);
  await supabase.from("gmail_connections").delete().eq("user_id", userId);
}

// ── Email sync helpers ──

import { getHeader, parseEmailAddress } from '@/lib/gmail-helpers';
import type { ParsedHeader } from '@/lib/gmail-helpers';
import { getOAuth2Client, refreshTokenIfNeeded, decryptOAuthToken } from '@/lib/oauth-helpers';
// Circular with email-send.ts (which imports sendEmail/getConnection from here);
// safe because both sides use the imports only inside function bodies.
import { sendTrackedEmail, SendPolicyError } from '@/lib/email-send';
import { trackServer } from '@/lib/analytics/server';

/**
 * Sync emails for a specific contact by querying Gmail for messages
 * to/from the contact's known email addresses.
 */
export async function syncEmailsForContact(
  userId: string,
  contactId: number,
  contactEmails: string[],
  gmailAddress: string,
  sinceDays = 90
) {
  if (contactEmails.length === 0) return 0;

  const gmail = await getGmailClient(userId);
  const supabase = createSupabaseServiceClient();

  // Use the latest cached email date to avoid re-fetching everything.
  // Subtract 1 day buffer to catch any messages that arrived around the same time.
  const { data: latestRow } = await supabase
    .from("email_messages")
    .select("date")
    .eq("user_id", userId)
    .eq("matched_contact_id", contactId)
    .order("date", { ascending: false })
    .limit(1)
    .single();

  let afterEpoch: number;
  if (latestRow?.date) {
    afterEpoch = Math.floor((new Date(latestRow.date).getTime() - 86400_000) / 1000);
  } else {
    afterEpoch = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);
  }

  const emailQuery = contactEmails.map((e) => `from:${e} OR to:${e}`).join(" OR ");
  const query = `(${emailQuery}) after:${afterEpoch}`;

  let pageToken: string | undefined;
  let totalSynced = 0;

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
        const isOutbound = fromAddr === gmailAddress.toLowerCase();

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
      const { data: existing } = await supabase
        .from("email_messages")
        .select("gmail_message_id")
        .eq("user_id", userId)
        .in("gmail_message_id", msgIds);
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
          .select("gmail_message_id, thread_id, direction");
        if (error) console.error("Insert error:", error);
        const inserted = insertedRows ?? [];

        // An inbound message means the contact wrote back — that reply is
        // what graduates imported prospects/bench into the active network
        // (plan 24 tier transition). Outbound-only threads never graduate.
        if (inserted.some((r) => r.direction === "inbound")) {
          const { error: actError } = await supabase
            .from("contacts")
            .update({ network_status: "active" })
            .eq("id", contactId)
            .in("network_status", ["prospect", "bench"]);
          if (actError) console.error("Failed to activate contact on reply:", actError);

          // CAR-38 north-star event: thread-attributed replies only — a new
          // inbound message counts as reply_received iff we previously sent
          // an outbound message on the same thread. The insert above is the
          // dedupe: only rows this call created are attributed, so re-syncs
          // and concurrent syncs can't recount. ai_assisted comes from the
          // outbound side of the thread (stamped at send time, CAR-58).
          const inbound = inserted.filter((r) => r.direction === "inbound" && r.thread_id);
          const threadIds = [...new Set(inbound.map((r) => r.thread_id as string))];
          if (threadIds.length > 0) {
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

      totalSynced += rows.length;
    }

    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken);

  return totalSynced;
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

// One serial Gmail query per contact means a full pass can outlast a single
// serverless invocation. The loop stops before the route's maxDuration and
// hands back a cursor so the client can immediately continue where it left off.
const SYNC_TIME_BUDGET_MS = 45_000;
const SYNC_CONTACT_PAGE = 1000;

/**
 * Full sync: iterate through all contacts with email addresses
 * and sync Gmail messages for each, in contact-id order.
 *
 * Contacts are fetched in pages (a single query is capped at 1000 rows)
 * and processed until the time budget runs out; `nextCursor` resumes the
 * pass. `last_gmail_sync_at` is only stamped when a pass reaches the end,
 * so a partial or all-failed pass never masquerades as a completed sync.
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

  let lastDoneId = opts.cursor ?? 0;
  let totalSynced = 0;
  let processedContacts = 0;
  let failedContacts = 0;
  let nextCursor: number | null = null;

  paging: while (true) {
    const { data: contacts, error } = await supabase
      .from("contacts")
      .select("id, contact_emails(email)")
      .eq("user_id", userId)
      .gt("id", lastDoneId)
      .order("id", { ascending: true })
      .range(0, SYNC_CONTACT_PAGE - 1);

    if (error) throw error;
    if (!contacts || contacts.length === 0) break;

    for (const contact of contacts) {
      const emails = (contact.contact_emails || [])
        .map((e: { email: string | null }) => e.email)
        .filter(Boolean) as string[];

      if (emails.length === 0) {
        lastDoneId = contact.id;
        continue;
      }

      // Always make progress: only yield after at least one contact synced.
      if (processedContacts > 0 && Date.now() - startedAt >= budgetMs) {
        nextCursor = lastDoneId;
        break paging;
      }

      try {
        totalSynced += await syncEmailsForContact(
          userId,
          contact.id,
          emails,
          conn.gmail_address,
          sinceDays
        );
      } catch (err) {
        failedContacts++;
        console.error(`Sync failed for contact ${contact.id}:`, err);
      }
      processedContacts++;
      lastDoneId = contact.id;
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

/**
 * Backfill orphaned email_messages for a contact.
 *
 * When a contact gains an email address (creation, import, or edit), there may
 * already be cached email_messages with that address that have no matched_contact_id.
 * This function claims those orphaned rows so they appear on the contact's timeline.
 */
export async function backfillEmailsForContact(
  userId: string,
  contactId: number,
  contactEmails: string[]
) {
  if (contactEmails.length === 0) return 0;

  const supabase = createSupabaseServiceClient();
  const lowerEmails = contactEmails.map((e) => e.toLowerCase());

  let totalMatched = 0;
  for (const email of lowerEmails) {
    // Match orphaned messages where from_address or to_addresses contains this
    // email. Detect matches via count, not a .select() read-back — the update
    // writes the matched_contact_id column the filter tests, the rule-17 shape
    // (CAR-139).
    const { count: matchedFrom } = await supabase
      .from("email_messages")
      .update({ matched_contact_id: contactId }, { count: "exact" })
      .eq("user_id", userId)
      .is("matched_contact_id", null)
      .eq("from_address", email);

    const { count: matchedTo } = await supabase
      .from("email_messages")
      .update({ matched_contact_id: contactId }, { count: "exact" })
      .eq("user_id", userId)
      .is("matched_contact_id", null)
      .contains("to_addresses", [email]);

    totalMatched += (matchedFrom || 0) + (matchedTo || 0);
  }

  return totalMatched;
}

/** Fetch the full body of a single Gmail message (HTML preferred, plaintext fallback). */
export async function getFullMessage(
  userId: string,
  gmailMessageId: string
): Promise<{ subject: string; from: string; to: string; date: string; bodyHtml: string | null; bodyText: string | null; messageId: string; threadId: string }> {
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

  return { subject, from, to, date, bodyHtml, bodyText, messageId, threadId };
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
  const { data: cached } = await supabase
    .from("email_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .gte("date", sinceDate)
    .limit(1);

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

    for (const msg of messages) {
      const headers = (msg.payload?.headers || []) as ParsedHeader[];
      const from = getHeader(headers, "From");
      const fromAddr = parseEmailAddress(from);
      const msgDate = Number(msg.internalDate || 0);
      if (fromAddr !== conn.gmail_address.toLowerCase() && msgDate >= sinceTime) {
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
  const { data, error } = await supabase
    .from("contact_emails")
    .select("contact_id, contacts!inner(user_id)")
    .ilike("email", email)
    .eq("contacts.user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error || !data?.contact_id) return;

  const { error: actError } = await supabase
    .from("contacts")
    .update({ network_status: "active" })
    .eq("id", data.contact_id)
    .in("network_status", ["prospect", "bench"]);
  if (actError) console.error("Failed to activate contact on reply:", actError);
}


export interface ComposeEmailOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyHtml: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

/** Build a base64url-encoded RFC 2822 message (shared by send and draft paths). */
export function buildMimeMessage(fromAddress: string, opts: ComposeEmailOptions): string {
  const mimeLines = [
    `From: ${fromAddress}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    `Subject: ${opts.subject}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    opts.bodyHtml,
  ];
  return Buffer.from(mimeLines.join("\r\n")).toString("base64url");
}

/** Compose a raw MIME message and send it via Gmail API. */
export async function sendEmail(
  userId: string,
  opts: ComposeEmailOptions
): Promise<{ messageId: string; threadId: string }> {
  const gmail = await getGmailClient(userId);
  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const raw = buildMimeMessage(conn.gmail_address, opts);

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    },
  });

  return {
    messageId: res.data.id || "",
    threadId: res.data.threadId || "",
  };
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

  const { data: pending } = await supabase
    .from("scheduled_emails")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .lte("scheduled_send_at", now);

  if (!pending || pending.length === 0) return { sent: 0, errors: 0 };

  let sent = 0;
  let errors = 0;

  for (const email of pending) {
    // Atomic claim (CAR-134): the 15-min cron is the sole send driver
    // (CAR-139 removed the page-load process triggers), but overlapping cron
    // ticks can still race, and the race window is the whole Gmail round trip.
    // Flip pending → sending first; whoever loses the CAS skips the row.
    // count, not .select() — the update writes the column the filter tests, so
    // a returning-representation read comes back empty on success (rule 17).
    const { count: claimed } = await supabase
      .from("scheduled_emails")
      .update(
        { status: ScheduledEmailStatus.Sending, claimed_at: now, updated_at: now },
        { count: "exact" },
      )
      .eq("id", email.id)
      .eq("status", "pending");
    if (claimed !== 1) continue;

    // Release the claim so a later tick retries. Guarded on 'sending' as
    // belt-and-braces against overwriting a concurrent status change.
    const releaseClaim = async () => {
      await supabase
        .from("scheduled_emails")
        .update({ status: "pending", claimed_at: null, updated_at: new Date().toISOString() })
        .eq("id", email.id)
        .eq("status", ScheduledEmailStatus.Sending);
    };

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
          // Cap reached (429) → stop the batch, retry next run. Bounce (422) →
          // leave pending; detectBounces cancels the row once the NDR lands.
          console.warn(`[scheduled] ${email.id} deferred: ${policyErr.message}`);
          await releaseClaim();
          if (policyErr.status === 429) break;
          continue;
        }
        throw policyErr;
      }

      // Mark as sent. Guarded on the claim so nothing else gets overwritten;
      // if this write is never reached (process killed mid-send), the row
      // stays 'sending' and the cron sweeper flags it 'failed' rather than
      // re-sending — the email may already be out.
      await supabase
        .from("scheduled_emails")
        .update({
          status: "sent",
          sent_at: now,
          gmail_message_id: result.messageId,
          sent_thread_id: result.threadId,
          updated_at: now,
        })
        .eq("id", email.id)
        .eq("status", ScheduledEmailStatus.Sending);

      // Update any follow-ups linked to this scheduled email
      await supabase
        .from("email_follow_ups")
        .update({
          original_gmail_message_id: result.messageId,
          thread_id: result.threadId,
          original_sent_at: now,
          updated_at: now,
        })
        .eq("scheduled_email_id", email.id);

      sent++;
    } catch (err) {
      // A throw here almost certainly precedes Gmail accepting the message:
      // the steps after the send inside sendTrackedEmail surface errors as
      // values, not throws. Release the claim so the next tick retries.
      console.error(`Error sending scheduled email ${email.id}:`, err);
      await releaseClaim();
      errors++;
    }
  }

  return { sent, errors };
}

/**
 * Bounce detection (plan 24 Phase 4).
 *
 * NDRs arrive from mailer-daemon/postmaster and never match a contact by
 * address, so the per-contact sync can't see them. This pass queries Gmail
 * for recent NDRs, reads the X-Failed-Recipients header (present on
 * Gmail-relayed bounces), then:
 *   1. sets contact_emails.bounced_at for the failed address,
 *   2. cancels pending follow-up sequence steps to that address —
 *      sequences otherwise auto-cancel only on reply and would fire
 *      steps 2–3 into the void and burn sender reputation.
 * Idempotent: bounced_at is only set once; re-running is safe.
 */
export async function detectBounces(
  userId: string,
  sinceDays = 14
): Promise<{ bounced: string[]; cancelledSequences: number }> {
  const gmail = await getGmailClient(userId);
  const supabase = createSupabaseServiceClient();
  const afterEpoch = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);

  const listRes = await withRetry(() =>
    gmail.users.messages.list({
      userId: "me",
      q: `from:(mailer-daemon OR postmaster OR "Mail Delivery Subsystem") after:${afterEpoch}`,
      maxResults: 50,
    })
  );

  const messageIds = (listRes.data.messages || []).map((m) => m.id!);
  if (messageIds.length === 0) return { bounced: [], cancelledSequences: 0 };

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
    for (const res of details) {
      const headers = (res.data.payload?.headers || []) as ParsedHeader[];
      const failed = getHeader(headers, "X-Failed-Recipients");
      if (failed) {
        for (const addr of failed.split(",")) {
          const clean = addr.trim().toLowerCase();
          if (clean) failedAddresses.add(clean);
        }
      }
    }
  }

  if (failedAddresses.size === 0) return { bounced: [], cancelledSequences: 0 };

  const now = new Date().toISOString();
  const bounced: string[] = [];
  let cancelledSequences = 0;

  for (const address of failedAddresses) {
    // Only touch addresses that belong to this user's contacts
    const { data: emailRows } = await supabase
      .from("contact_emails")
      .select("id, bounced_at, contacts!inner(user_id)")
      .eq("email", address)
      .eq("contacts.user_id", userId);
    if (!emailRows || emailRows.length === 0) continue;

    bounced.push(address);
    const toMark = emailRows.filter((r) => !r.bounced_at).map((r) => r.id);
    if (toMark.length > 0) {
      await supabase
        .from("contact_emails")
        .update({ bounced_at: now })
        .in("id", toMark);
    }

    // Cancel active follow-up sequences aimed at the dead address
    const { data: sequences } = await supabase
      .from("email_follow_ups")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("recipient_email", address);
    for (const seq of sequences || []) {
      await supabase
        .from("email_follow_ups")
        .update({ status: "cancelled_bounce", updated_at: now })
        .eq("id", seq.id);
      await supabase
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("follow_up_id", seq.id)
        .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
      cancelledSequences++;
    }
  }

  return { bounced, cancelledSequences };
}
