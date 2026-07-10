import OpenAI, { APIError } from "openai";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { openaiKeySaveSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { encryptSecret, CryptoError } from "@/lib/crypto";
import { DEFAULT_MODEL, evictOpenAIKeyCache } from "@/lib/openai";

const OPENAI_PROVIDER = "openai";
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
    throw new ApiError("Couldn't reach OpenAI to verify — try again.", 502);
  }
}

/**
 * GET /api/settings/openai-key — metadata only, never the key itself.
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
        .select("shared_access")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    // sharedAccess tells the UI whether the no-key state is a hard block (must
    // BYO) or a courtesy fallback — the surfacing end of CAR-26's gating.
    const sharedAccess = accessResult.data?.shared_access === true;
    const { data, error } = keyResult;

    if (error || !data) {
      return { hasKey: false, sharedAccess };
    }

    return { ...formatKeyStatus(data), sharedAccess };
  },
});

/**
 * PUT /api/settings/openai-key — validate, encrypt, and store a user's key.
 */
export const PUT = withApiHandler({
  schema: openaiKeySaveSchema,
  handler: async ({ user, body, track }) => {
    checkSaveRateLimit(user.id);

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
