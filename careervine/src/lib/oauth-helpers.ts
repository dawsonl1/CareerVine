/**
 * Shared OAuth token refresh logic for Gmail and Calendar clients.
 * Both services share the same gmail_connections row.
 */

import type { OAuth2Client } from "google-auth-library";

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
  } catch {
    await supabase.from("gmail_connections").delete().eq("user_id", userId);
    throw new Error(`${serviceName} session expired. Please reconnect your account.`);
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
