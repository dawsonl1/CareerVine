/**
 * POST /api/admin/encrypt-gmail-tokens — one-shot (but idempotent) backfill
 * that rewrites plaintext gmail_connections OAuth tokens as AES-256-GCM
 * ciphertext (CAR-27). Rows written after the CAR-27 deploy are already
 * encrypted; this migrates the rows that predate it.
 *
 * Machine route in the same style as ai-access: no user session, bearer
 * BUNDLE_ADMIN_TOKEN, service-role client. Safe to re-run — already-encrypted
 * tokens (v1. prefix) are skipped, and each rewrite is CAS-guarded on the
 * original values so a concurrent token refresh can't be clobbered.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { isAuthorizedAdminToken } from "@/app/api/admin/bundles/publish/route";
import { encryptOAuthToken } from "@/lib/oauth-helpers";

const CIPHERTEXT_PREFIX = "v1.";

export async function POST(req: NextRequest) {
  if (!isAuthorizedAdminToken(req.headers.get("authorization"), process.env.BUNDLE_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();

  const { data: rows, error } = await service
    .from("gmail_connections")
    .select("id, access_token, refresh_token");
  if (error) {
    console.error("[admin/encrypt-gmail-tokens] read failed:", error);
    return NextResponse.json({ error: "Failed to read connections" }, { status: 500 });
  }

  let encrypted = 0;
  let alreadyEncrypted = 0;
  let skippedRaced = 0;

  for (const row of rows || []) {
    const patch: Record<string, string> = {};
    if (!row.access_token.startsWith(CIPHERTEXT_PREFIX)) {
      patch.access_token = encryptOAuthToken(row.access_token);
    }
    if (!row.refresh_token.startsWith(CIPHERTEXT_PREFIX)) {
      patch.refresh_token = encryptOAuthToken(row.refresh_token);
    }

    if (Object.keys(patch).length === 0) {
      alreadyEncrypted++;
      continue;
    }

    // CAS on the original values: if a token refresh landed between our read
    // and this write, the filter misses and we leave the newer (already
    // encrypted) tokens alone. Success is detected via count — never via
    // .select() on columns the filter tests (PostgREST re-applies request
    // filters to RETURNING rows, so a successful update would read as empty).
    const { error: updateError, count } = await service
      .from("gmail_connections")
      .update({ ...patch, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", row.id)
      .eq("access_token", row.access_token)
      .eq("refresh_token", row.refresh_token);

    if (updateError) {
      console.error(`[admin/encrypt-gmail-tokens] update failed for row ${row.id}:`, updateError);
      return NextResponse.json({ error: `Failed to update row ${row.id}` }, { status: 500 });
    }

    if (count === 1) encrypted++;
    else skippedRaced++;
  }

  return NextResponse.json({ encrypted, alreadyEncrypted, skippedRaced });
}
