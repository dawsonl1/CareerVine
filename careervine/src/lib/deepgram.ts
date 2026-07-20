/**
 * Per-user BYO Deepgram key routing for transcription.
 *
 * Mirrors src/lib/openai.ts: resolves a user's own Deepgram key when active,
 * otherwise falls back to CareerVine's shared DEEPGRAM_API_KEY. A failing user
 * key is marked (invalid / quota_exceeded) and the call is retried on the
 * shared key, so transcription never hard-fails because of a bad BYO key.
 *
 * Deepgram keys power ONLY transcription and are independent of the OpenAI
 * BYO key (which powers text AI). There is no provider switch — routing is by
 * feature, and this module is the Deepgram half.
 */

import "server-only";

import { DeepgramClient } from "@deepgram/sdk";
import { ApiError } from "@/lib/api-handler";
import { decryptSecret, CryptoError } from "@/lib/crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
// Deepgram "quota" means a depleted prepaid balance or a rate limit. Unlike
// OpenAI's free daily tokens, a Deepgram balance does not auto-reset each day,
// so we hold the flag longer (re-checked on the next use once it expires).
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEEPGRAM_PROVIDER = "deepgram";

type CacheEntry = {
  apiKey: string;
  status: string;
  rowUpdatedAt: string;
  expiresAt: number;
};

const keyCache = new Map<string, CacheEntry>();

export type DeepgramSource = "user" | "app";

export type ResolvedDeepgram = {
  client: DeepgramClient;
  source: DeepgramSource;
};

export type DeepgramRunner = <T>(
  fn: (client: DeepgramClient, source: DeepgramSource) => Promise<T>,
) => Promise<T>;

/**
 * Returns the shared app Deepgram key, or throws a friendly, coded error when
 * it isn't configured. Callers surface `deepgram_unavailable` to the user.
 */
export function getAppDeepgramKey(): string {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new ApiError(
      "Transcription isn't available right now.",
      503,
      "deepgram_unavailable",
    );
  }
  return apiKey;
}

export function evictDeepgramKeyCache(userId: string): void {
  keyCache.delete(userId);
}

function evictOldestCacheEntry(): void {
  const oldest = keyCache.keys().next().value;
  if (oldest) keyCache.delete(oldest);
}

function setCachedKey(
  userId: string,
  apiKey: string,
  status: string,
  rowUpdatedAt: string,
): void {
  if (keyCache.size >= MAX_CACHE_ENTRIES) {
    evictOldestCacheEntry();
  }
  keyCache.set(userId, {
    apiKey,
    status,
    rowUpdatedAt,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getCachedEntry(userId: string): CacheEntry | null {
  const entry = keyCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    keyCache.delete(userId);
    return null;
  }
  return entry;
}

function buildClient(apiKey: string): DeepgramClient {
  return new DeepgramClient({ apiKey });
}

function isQuotaCooldownExpired(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() >= QUOTA_COOLDOWN_MS;
}

function isUserKeyEligible(status: string, updatedAt: string): boolean {
  if (status === "invalid") return false;
  if (status === "quota_exceeded" && !isQuotaCooldownExpired(updatedAt)) return false;
  return true;
}

async function isCacheEntryValid(userId: string, entry: CacheEntry): Promise<boolean> {
  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("user_api_keys")
      .select("status, updated_at")
      .eq("user_id", userId)
      .eq("provider", DEEPGRAM_PROVIDER)
      .maybeSingle();

    if (error || !data) return false;
    if (data.updated_at !== entry.rowUpdatedAt) return false;
    if (data.status !== entry.status) return false;
    return isUserKeyEligible(data.status, data.updated_at);
  } catch {
    return false;
  }
}

async function markKeyStatus(
  userId: string,
  status: "active" | "invalid" | "quota_exceeded",
): Promise<void> {
  try {
    const service = createSupabaseServiceClient();
    const now = new Date().toISOString();

    if (status === "active") {
      // Never clobber a concurrent invalid/quota_exceeded mark from another request.
      await service
        .from("user_api_keys")
        .update({ status: "active", updated_at: now })
        .eq("user_id", userId)
        .eq("provider", DEEPGRAM_PROVIDER)
        .in("status", ["active", "quota_exceeded"]);
      return;
    }

    await service
      .from("user_api_keys")
      .update({ status, updated_at: now })
      .eq("user_id", userId)
      .eq("provider", DEEPGRAM_PROVIDER);
  } catch {
    // Best-effort — routing must not fail because a status update failed.
  }
}

function touchLastUsed(userId: string): void {
  void (async () => {
    try {
      const service = createSupabaseServiceClient();
      await service
        .from("user_api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("provider", DEEPGRAM_PROVIDER);
    } catch {
      // Best-effort
    }
  })();
}

/** Extracts an HTTP-ish status code from a thrown Deepgram/SDK error. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e.status ?? e.statusCode ?? e.response?.status;
}

/** A rejected/invalid Deepgram key — 401 Unauthorized or 403 Forbidden. */
export function isDeepgramAuthError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 401 || status === 403;
}

/** Depleted balance or rate limit — 402 Payment Required or 429 Too Many Requests. */
export function isDeepgramQuotaError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 402 || status === 429;
}

/**
 * Resolves the Deepgram client for a user, preferring their BYO key when
 * active. Any lookup/decryption failure falls back to the shared app key.
 */
export async function getDeepgramForUser(userId: string): Promise<ResolvedDeepgram> {
  try {
    const cachedEntry = getCachedEntry(userId);
    if (cachedEntry) {
      const stillValid = await isCacheEntryValid(userId, cachedEntry);
      if (stillValid) {
        touchLastUsed(userId);
        return { client: buildClient(cachedEntry.apiKey), source: "user" };
      }
      keyCache.delete(userId);
    }

    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("user_api_keys")
      .select("encrypted_key, status, updated_at")
      .eq("user_id", userId)
      .eq("provider", DEEPGRAM_PROVIDER)
      .maybeSingle();

    if (error || !data) {
      return { client: buildClient(getAppDeepgramKey()), source: "app" };
    }

    if (!isUserKeyEligible(data.status, data.updated_at)) {
      return { client: buildClient(getAppDeepgramKey()), source: "app" };
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(data.encrypted_key);
    } catch (err) {
      if (err instanceof CryptoError) {
        void markKeyStatus(userId, "invalid");
      }
      return { client: buildClient(getAppDeepgramKey()), source: "app" };
    }

    setCachedKey(userId, apiKey, data.status, data.updated_at);
    touchLastUsed(userId);
    return { client: buildClient(apiKey), source: "user" };
  } catch (err) {
    // If even the app key is missing, propagate the coded ApiError so the
    // caller can surface "transcription unavailable" instead of a 500.
    if (err instanceof ApiError) throw err;
    return { client: buildClient(getAppDeepgramKey()), source: "app" };
  }
}

const routing = {
  getDeepgramForUser,
  getAppDeepgramKey,
};

/**
 * Runs a Deepgram call with per-user key routing and graceful fallback.
 *
 * On a user key being rejected (401/403) or out of credit (402/429), the key
 * is marked and the call is retried once on the shared app key. If the shared
 * key also fails, a friendly coded ApiError is thrown for the UI to map.
 */
export async function runWithDeepgramFallback<T>(
  userId: string,
  fn: (client: DeepgramClient, source: DeepgramSource) => Promise<T>,
): Promise<T> {
  const resolved = await routing.getDeepgramForUser(userId);

  try {
    const result = await fn(resolved.client, resolved.source);
    if (resolved.source === "user") {
      void markKeyStatus(userId, "active");
    }
    return result;
  } catch (err) {
    // The shared key failed — nothing left to fall back to.
    if (resolved.source === "app") {
      throw appKeyFailure(err);
    }

    const auth = isDeepgramAuthError(err);
    const quota = isDeepgramQuotaError(err);

    if (auth || quota) {
      evictDeepgramKeyCache(userId);
      void markKeyStatus(userId, auth ? "invalid" : "quota_exceeded");
      try {
        const appClient = buildClient(routing.getAppDeepgramKey());
        return await fn(appClient, "app");
      } catch (retryErr) {
        throw appKeyFailure(retryErr, /* userKeyWasBad */ true, quota);
      }
    }

    // A transient/unknown failure on the user's key — surface generically.
    throw new ApiError("Transcription failed. Please try again.", 502, "deepgram_failed");
  }
}

/**
 * Maps a shared-key failure to a friendly, coded ApiError. `userKeyWasBad`
 * lets the UI add a "your key is the one that's empty" nudge.
 */
function appKeyFailure(err: unknown, userKeyWasBad = false, userQuota = false): ApiError {
  if (isDeepgramQuotaError(err)) {
    return new ApiError(
      userKeyWasBad && userQuota
        ? "Your Deepgram key is out of credit, and CareerVine's shared transcription is also over capacity. Add credit to your key or remove it in Settings → AI, or try again shortly."
        : "Transcription is temporarily unavailable: the service is over capacity or out of credit. Please try again shortly.",
      503,
      "deepgram_no_credit",
    );
  }
  if (isDeepgramAuthError(err)) {
    // The shared key itself is misconfigured — an operator problem, not the user's.
    return new ApiError("Transcription isn't available right now.", 503, "deepgram_unavailable");
  }
  return new ApiError("Transcription failed. Please try again.", 502, "deepgram_failed");
}

/** Test-only hook for spying on routing without same-module call bypass. */
export const deepgramRoutingInternals: typeof routing | undefined =
  process.env.NODE_ENV === "test" ? routing : undefined;

export function createDeepgramRunner(userId: string): DeepgramRunner {
  return (fn) => runWithDeepgramFallback(userId, fn);
}
