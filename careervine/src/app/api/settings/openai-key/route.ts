import OpenAI, { APIError } from "openai";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { openaiKeySaveSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { encryptSecret, CryptoError } from "@/lib/crypto";
import { DEFAULT_MODEL, evictOpenAIKeyCache } from "@/lib/openai";

const OPENAI_PROVIDER = "openai";

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

async function validateOpenAIKey(apiKey: string): Promise<void> {
  const client = new OpenAI({ apiKey });

  try {
    await client.responses.create({
      model: DEFAULT_MODEL,
      input: "Reply with one word: hello",
      max_output_tokens: 16,
    });
  } catch (err) {
    if (err instanceof APIError) {
      if (err.status === 401) {
        throw new ApiError(
          "That key was rejected by OpenAI. Check that you copied the full key.",
          400,
        );
      }
      if (err.code === "insufficient_quota") {
        throw new ApiError(
          "Your key is valid but has no available quota. Enable data sharing for free daily tokens (see the video above) or add credit to your OpenAI account.",
          400,
        );
      }
    }
    throw new ApiError("Couldn't reach OpenAI to verify. Try again.", 502);
  }
}

/**
 * GET /api/settings/openai-key — metadata only, never the key itself.
 *
 * Deliberately a passive read of user_ai_access (CAR-51): opening Settings
 * must never arm the 24h trial or run the lazy expiry flip — those side
 * effects belong to real AI-use paths in lib/openai.ts only.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const [keyResult, accessResult] = await Promise.all([
      service
        .from("user_api_keys")
        .select("key_last4, status, created_at, last_used_at")
        .eq("user_id", user.id)
        .eq("provider", OPENAI_PROVIDER)
        .maybeSingle(),
      service
        .from("user_ai_access")
        .select("shared_access, expires_at, granted_by, access_requested_at")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    // sharedAccess tells the UI whether the no-key state is a hard block (must
    // BYO) or a courtesy fallback — the surfacing end of CAR-26's gating.
    // trialState (CAR-51) adds the trial nuance: 'active' shows the quiet
    // "first day" note, 'expired' shows the locked state with a request-access
    // exit. Raw shared_access can lag the expiry (lazy flip), so the effective
    // value is recomputed here.
    const access = accessResult.data;
    const expiresAtMs = access?.expires_at ? new Date(access.expires_at).getTime() : null;
    const expired = expiresAtMs !== null && expiresAtMs <= Date.now();
    const sharedAccess = access?.shared_access === true && !expired;
    const isTrial = access?.granted_by === "trial";
    const trialState = isTrial ? (expired ? ("expired" as const) : ("active" as const)) : null;
    const accessFields = {
      sharedAccess,
      trialState,
      sharedAccessExpiresAt: isTrial && !expired ? access?.expires_at ?? null : null,
      accessRequestedAt: access?.access_requested_at ?? null,
    };

    const { data, error } = keyResult;
    if (error || !data) {
      return { hasKey: false, ...accessFields };
    }

    return { ...formatKeyStatus(data), ...accessFields };
  },
});

/**
 * PUT /api/settings/openai-key — validate, encrypt, and store a user's key.
 */
export const PUT = withApiHandler({
  schema: openaiKeySaveSchema,
  // Save validates by calling OpenAI, so it fronts real spend. Fail closed
  // (CAR-149) so a limiter outage can't turn key-save into an unmetered
  // validation oracle. 5 attempts / 10 min matches the old Map limiter.
  rateLimit: { bucket: "settings-openai-key-save", limit: 5, window: "10 m", failClosed: true },
  handler: async ({ user, body, track }) => {
    const apiKey = body.apiKey;

    let encryptedKey: string;
    try {
      encryptedKey = encryptSecret(apiKey);
    } catch (err) {
      if (err instanceof CryptoError) {
        console.error("[settings/openai-key] BYOK_ENCRYPTION_KEY is not configured");
        throw new ApiError("Key storage is not configured on the server.", 500);
      }
      throw err;
    }

    await validateOpenAIKey(apiKey);

    const service = createSupabaseServiceClient();
    const now = new Date().toISOString();
    const { data, error } = await service
      .from("user_api_keys")
      .upsert({
        user_id: user.id,
        provider: OPENAI_PROVIDER,
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

    evictOpenAIKeyCache(user.id);
    track("api_key_saved", { provider: "openai" });
    return formatKeyStatus(data);
  },
});

/**
 * DELETE /api/settings/openai-key — remove stored key.
 */
export const DELETE = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    await service
      .from("user_api_keys")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", OPENAI_PROVIDER);

    evictOpenAIKeyCache(user.id);
    return { hasKey: false };
  },
});
