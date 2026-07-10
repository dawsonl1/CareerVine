/**
 * Verify Supabase-issued OAuth JWTs for the MCP resource server (CAR-13).
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getSupabaseAuthIssuer, getSupabaseJwksUrl } from "@/mcp/auth-config";

let jwks: JWTVerifyGetKey | null = null;

function getJwks(): JWTVerifyGetKey {
  if (!jwks) jwks = createRemoteJWKSet(new URL(getSupabaseJwksUrl()));
  return jwks;
}

/** Test hook — inject a local JWKS for unit tests. */
export function setJwksForTests(key: JWTVerifyGetKey | null): void {
  jwks = key;
}

export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken?.trim()) return undefined;

  try {
    const issuer = getSupabaseAuthIssuer();
    const { payload } = await jwtVerify(bearerToken, getJwks(), { issuer });

    if (payload.role !== "authenticated") return undefined;
    if (typeof payload.sub !== "string" || !payload.sub) return undefined;

    // Only OAuth-issued tokens carry a client id; plain app session JWTs
    // (same signer, same claims otherwise) must not unlock the MCP API.
    const clientId =
      typeof payload.client_id === "string" && payload.client_id
        ? payload.client_id
        : typeof payload.azp === "string" && payload.azp
          ? payload.azp
          : undefined;
    if (!clientId) return undefined;

    return {
      token: bearerToken,
      clientId,
      scopes: [],
      extra: { userId: payload.sub },
    };
  } catch {
    return undefined;
  }
}
