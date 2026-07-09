/**
 * Shared OpenAI client factory and per-user BYO key routing.
 *
 * Centralizes API key handling and default model configuration
 * so every call site doesn't repeat the same setup.
 */

import OpenAI, { APIError } from "openai";
import { ApiError } from "@/lib/api-handler";
import { decryptSecret, CryptoError } from "@/lib/crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

let cachedAppClient: OpenAI | null = null;

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const OPENAI_PROVIDER = "openai";

type CacheEntry = {
  apiKey: string;
  status: string;
  rowUpdatedAt: string;
  expiresAt: number;
};

const keyCache = new Map<string, CacheEntry>();

export type ResolvedOpenAI = {
  client: OpenAI;
  source: "user" | "app";
};

export type OpenAIRunner = <T>(fn: (client: OpenAI) => Promise<T>) => Promise<T>;

/** Default model for AI features. Reads OPENAI_MODEL env var with fallback. */
export const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

/**
 * Returns the app-owned OpenAI client (cached module-level).
 * Throws a friendly ApiError if the API key is not configured.
 */
export function getAppOpenAIClient(): OpenAI {
  if (cachedAppClient) return cachedAppClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ApiError("OpenAI API key not configured", 500);
  }

  cachedAppClient = new OpenAI({ apiKey });
  return cachedAppClient;
}

/** @deprecated Use getAppOpenAIClient or runWithOpenAIFallback instead. */
export function getOpenAIClient(): OpenAI {
  return getAppOpenAIClient();
}

export function evictOpenAIKeyCache(userId: string): void {
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

function buildClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
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
      .eq("provider", OPENAI_PROVIDER)
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
        .eq("provider", OPENAI_PROVIDER)
        .in("status", ["active", "quota_exceeded"]);
      return;
    }

    await service
      .from("user_api_keys")
      .update({ status, updated_at: now })
      .eq("user_id", userId)
      .eq("provider", OPENAI_PROVIDER);
  } catch {
    // Best-effort — routing must not fail because status update failed
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
        .eq("provider", OPENAI_PROVIDER);
    } catch {
      // Best-effort
    }
  })();
}

export function scrubOpenAIError(err: unknown): never {
  if (err instanceof APIError) {
    throw new APIError(
      err.status,
      { message: "OpenAI request failed" },
      "OpenAI request failed",
      err.headers,
    );
  }
  throw err;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof APIError) return err.status === 401;
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 401;
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof APIError) return err.code === "insufficient_quota";
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "insufficient_quota";
}

/**
 * Resolves the OpenAI client for a user, preferring their BYO key when active.
 * Any lookup/decryption failure falls back to the app client.
 */
export async function getOpenAIForUser(userId: string): Promise<ResolvedOpenAI> {
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
      .eq("provider", OPENAI_PROVIDER)
      .maybeSingle();

    if (error || !data) {
      return { client: getAppOpenAIClient(), source: "app" };
    }

    if (!isUserKeyEligible(data.status, data.updated_at)) {
      return { client: getAppOpenAIClient(), source: "app" };
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(data.encrypted_key);
    } catch (err) {
      if (err instanceof CryptoError) {
        void markKeyStatus(userId, "invalid");
      }
      return { client: getAppOpenAIClient(), source: "app" };
    }

    setCachedKey(userId, apiKey, data.status, data.updated_at);
    touchLastUsed(userId);
    return { client: buildClient(apiKey), source: "user" };
  } catch {
    return { client: getAppOpenAIClient(), source: "app" };
  }
}

const routing = {
  getOpenAIForUser,
  getAppOpenAIClient,
};

/**
 * Runs an OpenAI call with per-user key routing and graceful fallback.
 */
export async function runWithOpenAIFallback<T>(
  userId: string,
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  const resolved = await routing.getOpenAIForUser(userId);

  try {
    const result = await fn(resolved.client);
    if (resolved.source === "user") {
      void markKeyStatus(userId, "active");
    }
    return result;
  } catch (err) {
    if (resolved.source === "app") {
      scrubOpenAIError(err);
    }

    if (isAuthError(err)) {
      evictOpenAIKeyCache(userId);
      void markKeyStatus(userId, "invalid");
      try {
        return await fn(routing.getAppOpenAIClient());
      } catch (retryErr) {
        scrubOpenAIError(retryErr);
      }
    }

    if (isQuotaError(err)) {
      evictOpenAIKeyCache(userId);
      void markKeyStatus(userId, "quota_exceeded");
      try {
        return await fn(routing.getAppOpenAIClient());
      } catch (retryErr) {
        scrubOpenAIError(retryErr);
      }
    }

    scrubOpenAIError(err);
  }
}

/** Test-only hook for spying on routing without same-module call bypass. */
export const openaiRoutingInternals: typeof routing | undefined =
  process.env.NODE_ENV === "test" ? routing : undefined;

export function createOpenAIRunner(userId: string): OpenAIRunner {
  return (fn) => runWithOpenAIFallback(userId, fn);
}
