/**
 * Low-level Gmail send + connection primitives (CAR-147).
 *
 * This leaf module holds the transport-layer pieces that BOTH gmail.ts and
 * email-send.ts need: the authenticated Gmail client factory, the connection
 * row lookup, the RFC 2822 MIME builder, and the raw send. It imports neither
 * gmail.ts nor email-send.ts, which is what lets those two modules depend on
 * each other's higher-level functions without a circular import
 * (email-send.ts's sendTrackedEmail wraps sendEmail here; gmail.ts's
 * processScheduledEmails calls sendTrackedEmail).
 */

import "server-only";

import { gmail as gmailClientFactory } from "@googleapis/gmail";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getOAuth2Client, refreshTokenIfNeeded, decryptOAuthToken } from "@/lib/oauth-helpers";

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

  return gmailClientFactory({ version: "v1", auth: oauth2Client });
}

/** Get the gmail connection row for a user (or null). */
export async function getConnection(userId: string) {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("gmail_connections")
    .select("id, gmail_address, send_as_aliases, modify_scope_granted, last_gmail_sync_at, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
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

/**
 * Strip CR/LF and other control characters from a value interpolated into a
 * MIME header, so no value can terminate its header line and inject new
 * headers (e.g. a subject containing "\r\nBcc: attacker@evil.com") — CAR-143.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/**
 * RFC 2047 encoded-word bytes-per-chunk budget: 45 UTF-8 bytes → 60 base64
 * chars → 72 chars with the =?UTF-8?B?...?= framing, under the 75-char limit.
 */
const ENCODED_WORD_MAX_BYTES = 45;

/**
 * RFC 2047-encode a header value when it contains non-ASCII characters
 * (raw UTF-8 in a header is malformed RFC 2822 and renders garbled in
 * strict clients). ASCII-only values pass through unchanged. Long values
 * are split across encoded words on code-point boundaries.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[ -~]*$/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > ENCODED_WORD_MAX_BYTES) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) chunks.push(chunk);
  // Join with CRLF + space: RFC 5322 folding keeps each encoded-word line
  // under the RFC 2047 76-char limit, and decoders drop folding whitespace
  // between adjacent encoded words. The continuation line starts with a
  // space, so this deliberate fold can never start a new header (attacker
  // CR/LF was already stripped by sanitizeHeaderValue before encoding).
  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/** Build a base64url-encoded RFC 2822 message (shared by send and draft paths). */
export function buildMimeMessage(fromAddress: string, opts: ComposeEmailOptions): string {
  const mimeLines = [
    `From: ${sanitizeHeaderValue(fromAddress)}`,
    `To: ${sanitizeHeaderValue(opts.to)}`,
    ...(opts.cc ? [`Cc: ${sanitizeHeaderValue(opts.cc)}`] : []),
    ...(opts.bcc ? [`Bcc: ${sanitizeHeaderValue(opts.bcc)}`] : []),
    `Subject: ${encodeHeaderValue(sanitizeHeaderValue(opts.subject))}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`] : []),
    ...(opts.references ? [`References: ${sanitizeHeaderValue(opts.references)}`] : []),
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
