/**
 * Gmail API service module
 *
 * Handles OAuth token management, email fetching, and contact-based sync.
 * Tokens are stored in the gmail_connections table via the service client
 * (bypasses RLS so API routes can read/write tokens server-side).
 */

import { google } from "googleapis";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Generate the Google consent URL that the user will be redirected to. */
export function getAuthUrl(state: string): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/** Exchange an authorization code for tokens and store them. */
export async function exchangeCodeForTokens(
  code: string,
  userId: string
): Promise<{ gmailAddress: string }> {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Missing access_token or refresh_token from Google");
  }

  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const gmailAddress = profile.data.emailAddress || "";

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase.from("gmail_connections").upsert(
    {
      user_id: userId,
      gmail_address: gmailAddress,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(tokens.expiry_date || Date.now() + 3600_000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) throw error;
  return { gmailAddress };
}

/** Load tokens from DB, refresh if expired, return an authenticated Gmail client. */
export async function getGmailClient(userId: string) {
  const supabase = createSupabaseServiceClient();

  const { data: conn, error } = await supabase
    .from("gmail_connections")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !conn) throw new Error("Gmail not connected");

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
    expiry_date: new Date(conn.token_expires_at).getTime(),
  });

  // Refresh if token is expired or about to expire (within 5 min)
  const expiresAt = new Date(conn.token_expires_at).getTime();
  if (Date.now() > expiresAt - 5 * 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    await supabase
      .from("gmail_connections")
      .update({
        access_token: credentials.access_token!,
        token_expires_at: new Date(credentials.expiry_date || Date.now() + 3600_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

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
      await oauth2Client.revokeToken(conn.access_token);
    } catch {
      // Token may already be invalid — continue with cleanup
    }
  }

  await supabase.from("email_messages").delete().eq("user_id", userId);
  await supabase.from("gmail_connections").delete().eq("user_id", userId);
}

// ── Email sync helpers ──

type ParsedHeader = { name: string; value: string };

function getHeader(headers: ParsedHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function parseEmailAddress(raw: string): string {
  const match = raw.match(/<(.+?)>/);
  return (match ? match[1] : raw).toLowerCase().trim();
}

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
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });

    const messageIds = (listRes.data.messages || []).map((m) => m.id!);
    if (messageIds.length === 0) break;

    // Fetch metadata for each message in parallel (batched)
    const batchSize = 20;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((id) =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          })
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
          date: getHeader(headers, "Date")
            ? new Date(getHeader(headers, "Date")).toISOString()
            : null,
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

      // Insert new messages (includes is_read from Gmail)
      if (newRows.length > 0) {
        const { error } = await supabase.from("email_messages").upsert(newRows, {
          onConflict: "user_id,gmail_message_id",
          ignoreDuplicates: false,
        });
        if (error) console.error("Insert error:", error);
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

/**
 * Full sync: iterate through all contacts with email addresses
 * and sync Gmail messages for each.
 */
export async function syncAllContactEmails(userId: string, sinceDays = 90) {
  const supabase = createSupabaseServiceClient();

  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, contact_emails(email)")
    .eq("user_id", userId);

  if (!contacts) return 0;

  let totalSynced = 0;
  for (const contact of contacts) {
    const emails = (contact.contact_emails || [])
      .map((e: { email: string | null }) => e.email)
      .filter(Boolean) as string[];

    if (emails.length === 0) continue;

    try {
      const count = await syncEmailsForContact(
        userId,
        contact.id,
        emails,
        conn.gmail_address,
        sinceDays
      );
      totalSynced += count;
    } catch (err) {
      console.error(`Sync failed for contact ${contact.id}:`, err);
    }
  }

  // Update last sync timestamp
  await supabase
    .from("gmail_connections")
    .update({ last_gmail_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  return totalSynced;
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
export async function processFollowUps(userId: string): Promise<{
  sent: number;
  cancelled: number;
  errors: number;
}> {
  const supabase = createSupabaseServiceClient();
  const now = new Date().toISOString();

  // Get all active follow-up sequences for this user that have pending messages due
  const { data: activeFollowUps } = await supabase
    .from("email_follow_ups")
    .select("*, email_follow_up_messages(*)")
    .eq("user_id", userId)
    .eq("status", "active");

  if (!activeFollowUps || activeFollowUps.length === 0) {
    return { sent: 0, cancelled: 0, errors: 0 };
  }

  let sent = 0;
  let cancelled = 0;
  let errors = 0;

  for (const followUp of activeFollowUps) {
    const pendingMessages = (followUp.email_follow_up_messages || [])
      .filter((m: { status: string; scheduled_send_at: string }) => m.status === "pending" && m.scheduled_send_at <= now)
      .sort((a: { sequence_number: number }, b: { sequence_number: number }) => a.sequence_number - b.sequence_number);

    if (pendingMessages.length === 0) continue;

    // Check for reply before sending
    const hasReply = await checkForReplyInThread(
      userId,
      followUp.thread_id,
      followUp.original_sent_at
    );

    if (hasReply) {
      // Cancel entire sequence
      await supabase
        .from("email_follow_ups")
        .update({ status: "cancelled_reply", updated_at: now })
        .eq("id", followUp.id);

      await supabase
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("follow_up_id", followUp.id)
        .eq("status", "pending");

      cancelled++;
      continue;
    }

    // Send the next due message (one at a time per sequence)
    const nextMsg = pendingMessages[0];
    try {
      await sendEmail(userId, {
        to: followUp.recipient_email,
        subject: nextMsg.subject,
        bodyHtml: nextMsg.body_html,
        threadId: followUp.thread_id,
      });

      await supabase
        .from("email_follow_up_messages")
        .update({ status: "sent", sent_at: now })
        .eq("id", nextMsg.id);

      sent++;

      // Check if all messages in the sequence are now sent/cancelled
      const { data: remaining } = await supabase
        .from("email_follow_up_messages")
        .select("id")
        .eq("follow_up_id", followUp.id)
        .eq("status", "pending");

      if (!remaining || remaining.length === 0) {
        await supabase
          .from("email_follow_ups")
          .update({ status: "completed", updated_at: now })
          .eq("id", followUp.id);
      }
    } catch (err) {
      console.error(`Error sending follow-up message ${nextMsg.id}:`, err);
      errors++;
    }
  }

  return { sent, cancelled, errors };
}

/** Compose a raw MIME message and send it via Gmail API. */
export async function sendEmail(
  userId: string,
  opts: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    bodyHtml: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }
): Promise<{ messageId: string; threadId: string }> {
  const gmail = await getGmailClient(userId);
  const conn = await getConnection(userId);
  if (!conn) throw new Error("Gmail not connected");

  const mimeLines = [
    `From: ${conn.gmail_address}`,
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

  const raw = Buffer.from(mimeLines.join("\r\n")).toString("base64url");

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
 * Process all pending scheduled emails that are due.
 * After sending each, update any follow-up sequences linked to the scheduled email
 * with the real Gmail message ID and thread ID.
 */
export async function processScheduledEmails(userId: string): Promise<{
  sent: number;
  errors: number;
}> {
  const supabase = createSupabaseServiceClient();
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
    try {
      const result = await sendEmail(userId, {
        to: email.recipient_email,
        cc: email.cc || undefined,
        bcc: email.bcc || undefined,
        subject: email.subject,
        bodyHtml: email.body_html,
        threadId: email.thread_id || undefined,
        inReplyTo: email.in_reply_to || undefined,
        references: email.references_header || undefined,
      });

      // Mark as sent
      await supabase
        .from("scheduled_emails")
        .update({
          status: "sent",
          sent_at: now,
          gmail_message_id: result.messageId,
          sent_thread_id: result.threadId,
          updated_at: now,
        })
        .eq("id", email.id);

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
      console.error(`Error sending scheduled email ${email.id}:`, err);
      errors++;
    }
  }

  return { sent, errors };
}
