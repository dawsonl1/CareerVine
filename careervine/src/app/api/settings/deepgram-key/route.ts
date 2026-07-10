import { withApiHandler, ApiError } from "@/lib/api-handler";
import { deepgramKeySaveSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { encryptSecret, CryptoError } from "@/lib/crypto";
import { evictDeepgramKeyCache } from "@/lib/deepgram";

const DEEPGRAM_PROVIDER = "deepgram";
const SAVE_WINDOW_MS = 10 * 60 * 1000;
const SAVE_MAX_ATTEMPTS = 5;

const saveAttempts = new Map<string, { count: number; windowStart: number }>();

function checkSaveRateLimit(userId: string): void {
  const now = Date.now();
  const entry = saveAttempts.get(userId);

  if (!entry || now - entry.windowStart >= SAVE_WINDOW_MS) {
    saveAttempts.set(userId, { count: 1, windowStart: now });
    return;
  }

  if (entry.count >= SAVE_MAX_ATTEMPTS) {
    throw new ApiError("Too many attempts. Please try again in a few minutes.", 429);
  }

  entry.count += 1;
}

function formatKeyStatus(row: {
  key_last4: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
}) {
  return {
    hasKey: true,
    last4: row.key_last4,
    status: row.status,
    addedAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Verifies a Deepgram key with a zero-cost authenticated call (list projects)
 * against Deepgram's REST API — version-stable and independent of the SDK.
 * Never surfaces the key in any error.
 */
async function validateDeepgramKey(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${apiKey}` },
    });
  } catch {
    throw new ApiError("Couldn't reach Deepgram to verify — try again.", 502);
  }

  if (res.ok) return;

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      "That key was rejected by Deepgram. Check that you copied the full key.",
      400,
    );
  }
  if (res.status === 402 || res.status === 429) {
    throw new ApiError(
      "That key is valid but has no available Deepgram credit. Add credit to your Deepgram account and try again.",
      400,
    );
  }
  throw new ApiError("Couldn't verify the key with Deepgram — try again.", 502);
}

/**
 * GET /api/settings/deepgram-key — metadata only, never the key itself.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("user_api_keys")
      .select("key_last4, status, created_at, last_used_at")
      .eq("user_id", user.id)
      .eq("provider", DEEPGRAM_PROVIDER)
      .maybeSingle();

    if (error || !data) {
      return { hasKey: false };
    }

    return formatKeyStatus(data);
  },
});

/**
 * PUT /api/settings/deepgram-key — validate, encrypt, and store a user's key.
 */
export const PUT = withApiHandler({
  schema: deepgramKeySaveSchema,
  handler: async ({ user, body, track }) => {
    checkSaveRateLimit(user.id);

    const apiKey = body.apiKey;

    let encryptedKey: string;
    try {
      encryptedKey = encryptSecret(apiKey);
    } catch (err) {
      if (err instanceof CryptoError) {
        console.error("[settings/deepgram-key] BYOK_ENCRYPTION_KEY is not configured");
        throw new ApiError("Key storage is not configured on the server.", 500);
      }
      throw err;
    }

    await validateDeepgramKey(apiKey);

    const service = createSupabaseServiceClient();
    const now = new Date().toISOString();
    const { data, error } = await service
      .from("user_api_keys")
      .upsert({
        user_id: user.id,
        provider: DEEPGRAM_PROVIDER,
        encrypted_key: encryptedKey,
        key_last4: apiKey.slice(-4),
        status: "active",
        last_validated_at: now,
        updated_at: now,
      })
      .select("key_last4, status, created_at, last_used_at")
      .single();

    if (error || !data) {
      throw new ApiError("Failed to save API key.", 500);
    }

    evictDeepgramKeyCache(user.id);
    track("api_key_saved", { provider: "deepgram" });
    return formatKeyStatus(data);
  },
});

/**
 * DELETE /api/settings/deepgram-key — remove stored key.
 */
export const DELETE = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    await service
      .from("user_api_keys")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", DEEPGRAM_PROVIDER);

    evictDeepgramKeyCache(user.id);
    return { hasKey: false };
  },
});
