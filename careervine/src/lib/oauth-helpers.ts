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

/**
 * Refresh an OAuth2 token if it's expired or about to expire (within 5 min).
 * On failure (revoked token), deletes the connection row and throws a clear error.
 */
export async function refreshTokenIfNeeded(
  supabase: any,
  oauth2Client: OAuth2Client,
  userId: string,
  expiresAt: number,
  serviceName: string,
) {
  if (Date.now() <= expiresAt - 5 * 60_000) return;

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
