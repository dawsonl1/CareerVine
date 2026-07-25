import { withApiHandler, ApiError } from "@/lib/api-handler";
import { deepgramKeySaveSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { encryptSecret, CryptoError } from "@/lib/crypto";
import { evictDeepgramKeyCache } from "@/lib/deepgram";

const DEEPGRAM_PROVIDER = "deepgram";

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
    throw new ApiError("Couldn't reach Deepgram to verify. Try again.", 502);
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
  throw new ApiError("Couldn't verify the key with Deepgram. Try again.", 502);
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

    // `error` and `!data` are split deliberately (CAR-204). Folding them
    // together answered 200 { hasKey: false } on a genuine read failure —
    // supabase-js RESOLVES with `{ error }` rather than throwing (learned rule
    // 42), so a permission error, statement timeout or pool exhaustion all
    // landed here. The card then rendered its no-key form over a key that was
    // still on file, the user pasted a replacement, and the upsert destroyed
    // the original. That is exactly the hazard CAR-188's client-side
    // `loadFailed` guard was written for, and the guard could never fire for it
    // because the response was a 200. `hasKey` is control flow, so it needs
    // must()-style handling per CONVENTIONS.md §d.
    if (error) {
      throw new ApiError("Couldn't load your key status. Please try again.", 500);
    }
    if (!data) {
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
  // Save validates by calling Deepgram, so it fronts real spend. Fail closed
  // (CAR-149) so a limiter outage can't turn key-save into an unmetered
  // validation oracle. 5 attempts / 10 min matches the old Map limiter.
  rateLimit: { bucket: "settings-deepgram-key-save", limit: 5, window: "10 m", failClosed: true },
  handler: async ({ user, body, track }) => {
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
