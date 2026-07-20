/**
 * Shared OpenAI client factory and per-user BYO key routing.
 *
 * Centralizes API key handling and default model configuration
 * so every call site doesn't repeat the same setup.
 *
 * CAR-26: routing is now entitlement-aware. A user without an eligible personal
 * key falls back to the shared app key ONLY if they have shared access
 * (user_ai_access.shared_access). Otherwise resolution returns a typed failure
 * (AiUnavailableError) that feature UIs render as a graceful "add your key" state
 * instead of silently spending the app owner's credits or throwing an opaque 500.
 */

import "server-only";

import OpenAI, { APIError } from "openai";
import { ApiError } from "@/lib/api-handler";
import { decryptSecret, CryptoError } from "@/lib/crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { trackServer } from "@/lib/analytics/server";
import { must } from "@/lib/data/client";
import {
  estimateCallCostUsd,
  getSharedAiSpendUsd,
  recordSharedAiSpend,
  SHARED_AI_SPEND_LIMIT_USD,
} from "@/lib/ai/spend";
import {
  AI_FAILURE_COPY,
  AI_UNAVAILABLE_STATUS,
  type AiFailureCode,
} from "@/lib/ai-errors";

let cachedAppClient: OpenAI | null = null;

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const OPENAI_PROVIDER = "openai";
const SHARED_ACCESS_CACHE_TTL_MS = 60_000;
/** CAR-51: shared-AI trial length, clocked from the user's first AI use. */
export const AI_TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  apiKey: string;
  status: string;
  rowUpdatedAt: string;
  expiresAt: number;
};

const keyCache = new Map<string, CacheEntry>();

/**
 * CAR-51: shared access is no longer a plain boolean — an entitlement can be
 * an expiring trial. `trialExpired` distinguishes "your free day ended"
 * (ai_trial_expired) from "you never had access" (ai_no_key).
 */
export type SharedAccessState = { granted: boolean; trialExpired: boolean };

type SharedAccessEntry = { state: SharedAccessState; expiresAt: number };
const sharedAccessCache = new Map<string, SharedAccessEntry>();

/** Personal-key state relevant to picking a failure code when no key is usable. */
type PersonalKeyState = "none" | "invalid" | "quota_exceeded";

export type OpenAIResolution =
  | { ok: true; client: OpenAI; source: "user" | "app" }
  | { ok: false; code: AiFailureCode };

export type OpenAIRunner = <T>(fn: (client: OpenAI) => Promise<T>) => Promise<T>;

/**
 * Thrown when no OpenAI key can serve a request (no personal key + no shared
 * access, a dead personal key with no fallback, or the shared key itself
 * failing). Carries an AI failure code the client maps to a graceful state.
 * Extends ApiError so it flows through withApiHandler as `{ error, code }` at
 * HTTP 402 with no extra handling.
 */
export class AiUnavailableError extends ApiError {
  constructor(public reason: AiFailureCode) {
    super(AI_FAILURE_COPY[reason].serverMessage, AI_UNAVAILABLE_STATUS, reason);
    this.name = "AiUnavailableError";
  }
}

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

export function evictSharedAccessCache(userId: string): void {
  sharedAccessCache.delete(userId);
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

type AccessRow = {
  shared_access: boolean;
  expires_at: string | null;
  granted_by: string | null;
};

const ACCESS_COLUMNS = "shared_access, expires_at, granted_by";

/**
 * CAR-51: first shared-key resolution for a user with NO entitlement row arms
 * their 24-hour trial. `ignoreDuplicates` (ON CONFLICT DO NOTHING) + an exact
 * count makes it atomic: count 1 = this request created the row and the trial
 * started now; count 0 = a concurrent request (or an existing row, including a
 * cutoff) won — trials never re-arm. Count-based per rule 17: the insert's
 * RETURNING representation can't be trusted through PostgREST filters.
 */
async function startTrial(
  service: ReturnType<typeof createSupabaseServiceClient>,
  userId: string,
): Promise<boolean> {
  const now = Date.now();
  const { count, error } = await service.from("user_ai_access").upsert(
    {
      user_id: userId,
      shared_access: true,
      granted_at: new Date(now).toISOString(),
      granted_by: "trial",
      expires_at: new Date(now + AI_TRIAL_DURATION_MS).toISOString(),
    },
    { onConflict: "user_id", ignoreDuplicates: true, count: "exact" },
  );
  if (error) return false;
  const started = (count ?? 0) === 1;
  if (started) {
    await trackServer(userId, "ai_trial_started", {});
  }
  return started;
}

/**
 * Evaluate an entitlement row, lazily retiring expired grants. The flip to
 * shared_access=false is a CAS (count-checked, rule 17): exactly one request
 * observes the transition, and that request emits the one-time
 * ai_trial_expired event. granted_by/expires_at survive as the trial
 * tombstone so the UI can keep telling "trial ended" apart from "never had
 * access".
 */
async function evaluateAccessRow(
  service: ReturnType<typeof createSupabaseServiceClient>,
  userId: string,
  row: AccessRow,
): Promise<SharedAccessState> {
  const isTrial = row.granted_by === "trial";
  const expired =
    row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now();

  if (row.shared_access && !expired) return { granted: true, trialExpired: false };

  if (row.shared_access && expired) {
    const { count } = await service
      .from("user_ai_access")
      .update(
        { shared_access: false, updated_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("user_id", userId)
      .eq("shared_access", true)
      .lte("expires_at", new Date().toISOString());
    if ((count ?? 0) === 1 && isTrial) {
      await trackServer(userId, "ai_trial_expired", {});
    }
    return { granted: false, trialExpired: isTrial };
  }

  return { granted: false, trialExpired: isTrial && expired };
}

/**
 * Whether the user is entitled to CareerVine's shared key — and if not,
 * whether that's because their trial expired. Cached 60s. Fails CLOSED on any
 * lookup error — the spend-safe default — but such a denial is NOT cached, so
 * a transient failure costs one request rather than a whole TTL window. Only
 * consulted when a personal key is unusable, so the common BYO-active path
 * never pays for this.
 *
 * Side effects (CAR-51): arms the 24h trial for row-less users and lazily
 * retires expired grants — so this must only run from real AI-use paths,
 * never from status/read endpoints.
 */
async function resolveSharedAccess(userId: string): Promise<SharedAccessState> {
  const cached = sharedAccessCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  let state: SharedAccessState = { granted: false, trialExpired: false };
  try {
    const service = createSupabaseServiceClient();
    // must(), not a bare destructure (CAR-158). A failed read returns
    // { data: null } WITHOUT throwing, and `!data` below means "this user has
    // no access row yet" — so a transient read failure would fall through to
    // startTrial() and re-arm a trial for a user who may already have access.
    // Throwing here lands in the catch below, which fails closed.
    let data = must(
      await service
        .from("user_ai_access")
        .select(ACCESS_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle(),
    );

    if (!data && (await startTrial(service, userId))) {
      state = { granted: true, trialExpired: false };
    } else {
      if (!data) {
        // Lost the trial-arm race (or insert failed) — re-read what won.
        ({ data } = await service
          .from("user_ai_access")
          .select(ACCESS_COLUMNS)
          .eq("user_id", userId)
          .maybeSingle());
      }
      if (data) {
        state = await evaluateAccessRow(service, userId, data as AccessRow);
      }
    }
  } catch {
    // Fail closed for THIS request only (CAR-158). The reads above throw on
    // transient DB failure, which says nothing about the user's entitlement —
    // caching that denial would deny AI for the full TTL, where a bare read
    // error used to recover on the very next request. Return without writing
    // the cache so the next call re-reads.
    return { granted: false, trialExpired: false };
  }

  sharedAccessCache.set(userId, {
    state,
    expiresAt: Date.now() + SHARED_ACCESS_CACHE_TTL_MS,
  });
  return state;
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
 * CAR-143 (R5.3): where does this user stand against the persisted shared-key
 * spend ceiling? Every non-"available" state fails CLOSED (no shared call),
 * but "exhausted" (genuinely over the ceiling → trial-expiry UX) is kept
 * distinct from "unknown" (lookup error → retryable ai_unavailable UX) so a
 * transient DB blip never tells a user their free AI ended for good.
 */
type SharedSpendBudget = "available" | "exhausted" | "unknown";

async function checkSharedSpendBudget(userId: string): Promise<SharedSpendBudget> {
  try {
    return (await getSharedAiSpendUsd(userId)) < SHARED_AI_SPEND_LIMIT_USD
      ? "available"
      : "exhausted";
  } catch {
    return "unknown";
  }
}

/**
 * No usable personal key: return the shared client if entitled, otherwise a
 * typed failure whose code reflects why the personal key was unusable. A dead
 * personal key keeps its key-specific code (more actionable than the trial
 * state); only keyless users get ai_trial_expired.
 *
 * CAR-143 (R5.3): entitlement alone is no longer enough — the shared key is
 * only handed out while the user is under the persisted spend ceiling.
 * Over-ceiling resolves like an exhausted entitlement (key-specific code when
 * a dead personal key exists, else the trial-expiry UX); an unreadable spend
 * state fails closed as the retryable ai_unavailable.
 */
async function resolveWithoutPersonalKey(
  userId: string,
  keyState: PersonalKeyState,
): Promise<OpenAIResolution> {
  const access = await routing.resolveSharedAccess(userId);
  if (access.granted) {
    const budget = await routing.checkSharedSpendBudget(userId);
    if (budget === "available") {
      try {
        return { ok: true, client: getAppOpenAIClient(), source: "app" };
      } catch {
        // Shared access granted but the app key isn't configured.
        return { ok: false, code: "ai_unavailable" };
      }
    }
    if (budget === "unknown") {
      // Spend state unreadable — deny this call, but as a transient outage.
      return { ok: false, code: "ai_unavailable" };
    }
    // "exhausted" falls through to the key-specific / trial-expiry codes.
  }

  if (keyState === "invalid") return { ok: false, code: "ai_key_invalid" };
  if (keyState === "quota_exceeded") return { ok: false, code: "ai_quota_exhausted" };
  if (access.granted || access.trialExpired) {
    // Entitled but out of budget, or trial over — both are "your free AI ended".
    return { ok: false, code: "ai_trial_expired" };
  }
  return { ok: false, code: "ai_no_key" };
}

/**
 * Resolves the OpenAI client for a user, preferring their BYO key when active,
 * else the shared key when entitled, else a typed AI-availability failure.
 * Any unexpected lookup/decryption failure resolves to `ai_unavailable`.
 */
export async function getOpenAIForUser(userId: string): Promise<OpenAIResolution> {
  try {
    const cachedEntry = getCachedEntry(userId);
    if (cachedEntry) {
      const stillValid = await isCacheEntryValid(userId, cachedEntry);
      if (stillValid) {
        touchLastUsed(userId);
        return { ok: true, client: buildClient(cachedEntry.apiKey), source: "user" };
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
      return resolveWithoutPersonalKey(userId, "none");
    }

    if (!isUserKeyEligible(data.status, data.updated_at)) {
      const keyState: PersonalKeyState =
        data.status === "invalid" ? "invalid" : "quota_exceeded";
      return resolveWithoutPersonalKey(userId, keyState);
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(data.encrypted_key);
    } catch (err) {
      if (err instanceof CryptoError) {
        void markKeyStatus(userId, "invalid");
      }
      // A key that can't be decrypted is as good as invalid.
      return resolveWithoutPersonalKey(userId, "invalid");
    }

    setCachedKey(userId, apiKey, data.status, data.updated_at);
    touchLastUsed(userId);
    return { ok: true, client: buildClient(apiKey), source: "user" };
  } catch {
    return { ok: false, code: "ai_unavailable" };
  }
}

const routing = {
  getOpenAIForUser,
  getAppOpenAIClient,
  resolveSharedAccess,
  checkSharedSpendBudget,
};

/**
 * A user-key call failed with an auth/quota error. Fall back to the shared key
 * if entitled, otherwise throw the typed failure so the UI can surface it.
 */
async function fallbackToSharedOrFail<T>(
  userId: string,
  fn: (client: OpenAI) => Promise<T>,
  failCode: AiFailureCode,
): Promise<T> {
  if (!(await routing.resolveSharedAccess(userId)).granted) {
    throw new AiUnavailableError(failCode);
  }
  // CAR-143 (R5.3): no shared-key call without spend budget, on any path.
  const budget = await routing.checkSharedSpendBudget(userId);
  if (budget === "unknown") throw new AiUnavailableError("ai_unavailable");
  if (budget === "exhausted") throw new AiUnavailableError(failCode);

  let appClient: OpenAI;
  try {
    appClient = routing.getAppOpenAIClient();
  } catch {
    throw new AiUnavailableError("ai_unavailable");
  }

  try {
    const result = await fn(appClient);
    void recordSharedAiSpend(userId, estimateCallCostUsd(result));
    return result;
  } catch (retryErr) {
    // The shared key itself is dead — nothing left to fall back to.
    if (isAuthError(retryErr) || isQuotaError(retryErr)) {
      throw new AiUnavailableError("ai_unavailable");
    }
    scrubOpenAIError(retryErr);
  }
}

/**
 * Runs an OpenAI call with per-user key routing and entitlement-aware fallback.
 * Throws AiUnavailableError when no key can serve the request; scrubs and
 * propagates other OpenAI errors (rate limit / 5xx / network).
 */
export async function runWithOpenAIFallback<T>(
  userId: string,
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  const resolved = await routing.getOpenAIForUser(userId);

  if (!resolved.ok) {
    throw new AiUnavailableError(resolved.code);
  }

  try {
    const result = await fn(resolved.client);
    if (resolved.source === "user") {
      void markKeyStatus(userId, "active");
    } else {
      // CAR-143 (R5.3): meter every successful shared-key call.
      void recordSharedAiSpend(userId, estimateCallCostUsd(result));
    }
    return result;
  } catch (err) {
    if (resolved.source === "app") {
      // The shared key itself failed. Auth/quota → nothing to fall back to.
      if (isAuthError(err) || isQuotaError(err)) {
        throw new AiUnavailableError("ai_unavailable");
      }
      scrubOpenAIError(err);
    }

    // resolved.source === "user": mark the key, then fall back only if entitled.
    if (isAuthError(err)) {
      evictOpenAIKeyCache(userId);
      void markKeyStatus(userId, "invalid");
      return fallbackToSharedOrFail(userId, fn, "ai_key_invalid");
    }

    if (isQuotaError(err)) {
      evictOpenAIKeyCache(userId);
      void markKeyStatus(userId, "quota_exceeded");
      return fallbackToSharedOrFail(userId, fn, "ai_quota_exhausted");
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
