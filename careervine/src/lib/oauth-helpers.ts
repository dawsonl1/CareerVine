/**
 * Shared OAuth helpers for Gmail and Calendar clients.
 * Both services share the same gmail_connections row.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/** Create a Google OAuth2 client from env vars. */
export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// In-memory lock to prevent concurrent token refreshes for the same user.
// If Gmail and Calendar both try to refresh at the same time, the second
// caller waits for the first to finish instead of issuing a duplicate refresh.
const refreshLocks = new Map<string, Promise<void>>();

/**
 * Refresh an OAuth2 token if it's expired or about to expire (within 5 min).
 * On failure (revoked token), deletes the connection row and throws a clear error.
 * Uses a per-user lock to prevent concurrent refresh races.
 */
export async function refreshTokenIfNeeded(
  supabase: any,
  oauth2Client: OAuth2Client,
  userId: string,
  expiresAt: number,
  serviceName: string,
) {
  if (Date.now() <= expiresAt - 5 * 60_000) return;

  // Wait for any in-flight refresh for this user to complete, then re-read the new token
  const existing = refreshLocks.get(userId);
  if (existing) {
    await existing;
    // The first caller updated the DB — re-read the fresh token into this caller's client
    const { data: fresh } = await supabase
      .from("gmail_connections")
      .select("access_token, refresh_token, token_expires_at")
      .eq("user_id", userId)
      .single();
    if (fresh) {
      oauth2Client.setCredentials({
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expiry_date: new Date(fresh.token_expires_at).getTime(),
      });
    }
    return;
  }

  const refreshPromise = doRefresh(supabase, oauth2Client, userId, serviceName);
  refreshLocks.set(userId, refreshPromise);
  try {
    await refreshPromise;
  } finally {
    refreshLocks.delete(userId);
  }
}

async function doRefresh(
  supabase: any,
  oauth2Client: OAuth2Client,
  userId: string,
  serviceName: string,
) {
  let credentials;
  try {
    ({ credentials } = await oauth2Client.refreshAccessToken());
  } catch (err: any) {
    // Only delete the connection for permanent auth failures (revoked/expired refresh token).
    // Transient errors (network, 5xx) should not destroy the user's connection.
    const isRevoked =
      err?.response?.data?.error === "invalid_grant" ||
      err?.message?.includes("invalid_grant") ||
      err?.code === 401;
    if (isRevoked) {
      await supabase.from("gmail_connections").delete().eq("user_id", userId);
      throw new Error(`${serviceName} session expired. Please reconnect your account.`);
    }
    throw err;
  }
  oauth2Client.setCredentials(credentials);

  if (credentials.access_token) {
    await supabase
      .from("gmail_connections")
      .update({
        access_token: credentials.access_token,
        token_expires_at: new Date(credentials.expiry_date || Date.now() + 3600_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }
}
