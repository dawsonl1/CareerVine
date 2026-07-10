/**
 * POST /api/admin/ai-access — grant or revoke a user's access to CareerVine's
 * shared OpenAI key (CAR-26).
 *
 * Machine route in the same style as the bundle admin route: no user session,
 * authenticated by the BUNDLE_ADMIN_TOKEN bearer secret, run on the service-role
 * client (user_ai_access has no client write policies). Identify the target by
 * uuid or email. This is the only way to flip shared_access — there is no admin
 * UI in v1; a curl from the owner's machine is enough.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { isAuthorizedAdminToken } from "@/app/api/admin/bundles/publish/route";
import { adminAiAccessSchema } from "@/lib/api-schemas";
import { evictSharedAccessCache } from "@/lib/openai";

export async function POST(req: NextRequest) {
  if (!isAuthorizedAdminToken(req.headers.get("authorization"), process.env.BUNDLE_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = adminAiAccessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const { sharedAccess } = parsed.data;
  const service = createSupabaseServiceClient();

  // Resolve the target user id (from uuid or via the app's users table by email).
  let userId = parsed.data.userId;
  if (!userId) {
    const { data: userRow, error } = await service
      .from("users")
      .select("id")
      .eq("email", parsed.data.email!)
      .maybeSingle();
    if (error) {
      console.error("[admin/ai-access] user lookup failed:", error);
      return NextResponse.json({ error: "User lookup failed" }, { status: 500 });
    }
    if (!userRow) {
      return NextResponse.json({ error: "No user found for that email" }, { status: 404 });
    }
    userId = (userRow as { id: string }).id;
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await service.from("user_ai_access").upsert(
    {
      user_id: userId,
      shared_access: sharedAccess,
      granted_at: sharedAccess ? now : null,
      granted_by: "admin",
      // Manual grants are permanent — and must overwrite a stale trial
      // expiry, or the upsert's conflict-merge would keep the user locked
      // (CAR-51). A grant also settles any pending access request.
      expires_at: null,
      ...(sharedAccess ? { access_requested_at: null } : {}),
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (upsertError) {
    console.error("[admin/ai-access] upsert failed:", upsertError);
    return NextResponse.json({ error: "Failed to update access" }, { status: 500 });
  }

  // Best-effort: clear this lambda's cached entitlement so the change is visible
  // immediately here (other instances converge within the 60s TTL).
  evictSharedAccessCache(userId);

  return NextResponse.json({ userId, sharedAccess });
}
