/**
 * Shared OAuth/MCP auth constants for the remote server (CAR-13).
 */

import { getSupabaseEnv } from "@/lib/supabase/config";

/** Canonical public app origin — apex redirects to www in production. */
export function getAppOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.careervine.app";
  return raw.replace(/\/$/, "");
}

export function getMcpResourceUrl(): string {
  return `${getAppOrigin()}/api/mcp`;
}

/** Supabase OAuth AS issuer — must match token `iss` exactly (include /auth/v1). */
export function getSupabaseAuthIssuer(): string {
  const { url } = getSupabaseEnv();
  return `${url.replace(/\/$/, "")}/auth/v1`;
}

export function getSupabaseJwksUrl(): string {
  return `${getSupabaseAuthIssuer()}/.well-known/jwks.json`;
}
