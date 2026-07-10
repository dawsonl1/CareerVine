import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import OpenAI, { APIError, AuthenticationError } from "openai";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret: vi.fn((value: string) => value.replace("enc:", "")),
  CryptoError: class CryptoError extends Error {},
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn().mockResolvedValue(undefined),
}));

import * as openaiModule from "@/lib/openai";
import { AiUnavailableError, AI_TRIAL_DURATION_MS } from "@/lib/openai";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { decryptSecret } from "@/lib/crypto";
import { trackServer } from "@/lib/analytics/server";

const routing = openaiModule.openaiRoutingInternals!;

/**
 * A permissive chainable that satisfies every query shape used by routing:
 *   select().eq().eq().maybeSingle()      (user_api_keys read)
 *   update().eq().eq()                    (awaited directly — thenable)
 *   update().eq().eq().in()               (mark active)
 */
function tableMock(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const inFn = vi.fn().mockResolvedValue({});
  const chain: Record<string, unknown> = {
    maybeSingle,
    in: inFn,
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  };
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  return { chain, maybeSingle, in: inFn };
}

/**
 * user_ai_access mock covering the CAR-51 shapes:
 *   select().eq().maybeSingle()                    (entitlement read; `rows`
 *                                                   consumed sequentially for
 *                                                   the arm-race re-read)
 *   upsert(payload, {ignoreDuplicates, count})     (trial arm — awaited directly)
 *   update(payload, {count}).eq().eq().lte()       (lazy expiry CAS flip)
 */
function accessTableMock(opts: {
  rows?: Array<Record<string, unknown> | null>;
  upsertCount?: number;
  flipCount?: number;
} = {}) {
  const rows = opts.rows ?? [null];
  const maybeSingle = vi.fn();
  for (const r of rows) maybeSingle.mockResolvedValueOnce({ data: r, error: null });
  maybeSingle.mockResolvedValue({ data: rows[rows.length - 1] ?? null, error: null });
  const upsert = vi.fn().mockResolvedValue({ count: opts.upsertCount ?? 0, error: null });
  const lte = vi.fn().mockResolvedValue({ count: opts.flipCount ?? 0, error: null });
  const update = vi.fn();
  const chain: Record<string, unknown> = { maybeSingle, upsert, lte, update };
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  update.mockImplementation(() => chain);
  return { chain, maybeSingle, upsert, lte, update };
}

type AccessMock = ReturnType<typeof accessTableMock>;

function mockDb(
  keyRow: Record<string, unknown> | null,
  access: AccessMock = accessTableMock(),
) {
  const keys = tableMock(keyRow);
  mockFrom.mockImplementation((table: string) =>
    table === "user_ai_access" ? access.chain : keys.chain,
  );
  return { keys, access };
}

/** An entitlement row; defaults to a permanent grant. */
function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    shared_access: true,
    expires_at: null,
    granted_by: "admin",
    ...overrides,
  };
}

/** A cutoff: row exists, no entitlement — trials never re-arm over it. */
function cutoffRow() {
  return { shared_access: false, expires_at: null, granted_by: null };
}

function activeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    encrypted_key: "enc:sk-user-key-1234567890",
    status: "active",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

describe("openai routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockImplementation(() => mockServiceClient as never);
    process.env.OPENAI_API_KEY = "sk-app-key";
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    openaiModule.evictOpenAIKeyCache("user-123");
    openaiModule.evictSharedAccessCache("user-123");
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  // ── Resolution: personal key ──────────────────────────────────────────

  it("uses the user key when the row is active", async () => {
    mockDb(activeKeyRow());
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "user" });
  });

  it("retries quota_exceeded keys after the cooldown", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    mockDb(activeKeyRow({ status: "quota_exceeded", updated_at: old }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "user" });
  });

  // ── Resolution: no usable personal key, NOT entitled → typed failures ──

  it("fails with ai_no_key when no key and a cutoff row (no trial re-arm)", async () => {
    const { access } = mockDb(null, accessTableMock({ rows: [cutoffRow()] }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_no_key" });
    expect(access.upsert).not.toHaveBeenCalled();
  });

  it("fails with ai_no_key when the trial arm loses and the re-read finds nothing", async () => {
    // Arm attempt returns count 0 (insert failed / raced) and the re-read is
    // still empty — the fail-safe path must deny, not grant.
    const { access } = mockDb(null, accessTableMock({ rows: [null, null], upsertCount: 0 }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_no_key" });
    expect(access.upsert).toHaveBeenCalledTimes(1);
  });

  it("fails with ai_key_invalid when the key is invalid and no shared access", async () => {
    mockDb(activeKeyRow({ status: "invalid" }), accessTableMock({ rows: [cutoffRow()] }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_key_invalid" });
  });

  it("fails with ai_quota_exhausted when quota is spent (in cooldown) and no shared access", async () => {
    mockDb(activeKeyRow({ status: "quota_exceeded" }), accessTableMock({ rows: [cutoffRow()] })); // fresh updated_at → still in cooldown
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_quota_exhausted" });
  });

  it("fails with ai_key_invalid when the key can't be decrypted and no shared access", async () => {
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error("corrupt");
    });
    mockDb(activeKeyRow(), accessTableMock({ rows: [cutoffRow()] }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_key_invalid" });
  });

  // ── Resolution: no usable personal key, ENTITLED → shared app client ───

  it("uses the app client when no key but shared access is granted", async () => {
    mockDb(null, accessTableMock({ rows: [accessRow()] }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });
  });

  it("uses the app client when the key is invalid but shared access is granted", async () => {
    mockDb(activeKeyRow({ status: "invalid" }), accessTableMock({ rows: [accessRow()] }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });
  });

  it("resolves ai_unavailable when the service client construction throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockImplementationOnce(() => {
      throw new Error("missing service role key");
    });
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_unavailable" });
  });

  // ── CAR-51: trial start ────────────────────────────────────────────────

  it("arms the 24h trial on the first row-less shared resolution", async () => {
    const { access } = mockDb(null, accessTableMock({ rows: [null], upsertCount: 1 }));
    const before = Date.now();
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });

    expect(access.upsert).toHaveBeenCalledTimes(1);
    const [payload, options] = access.upsert.mock.calls[0];
    expect(payload).toMatchObject({
      user_id: "user-123",
      shared_access: true,
      granted_by: "trial",
    });
    const expiresMs = new Date(payload.expires_at as string).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + AI_TRIAL_DURATION_MS);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + AI_TRIAL_DURATION_MS);
    expect(options).toMatchObject({ onConflict: "user_id", ignoreDuplicates: true, count: "exact" });

    expect(trackServer).toHaveBeenCalledWith("user-123", "ai_trial_started", {});
  });

  it("grants without a started event when a concurrent request armed the trial first", async () => {
    const winner = accessRow({ granted_by: "trial", expires_at: FUTURE });
    mockDb(null, accessTableMock({ rows: [null, winner], upsertCount: 0 }));
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });
    expect(trackServer).not.toHaveBeenCalled();
  });

  // ── CAR-51: trial expiry ───────────────────────────────────────────────

  it("denies with ai_trial_expired and emits the one-time event on the winning flip", async () => {
    const expired = accessRow({ granted_by: "trial", expires_at: PAST });
    const { access } = mockDb(null, accessTableMock({ rows: [expired], flipCount: 1 }));

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_trial_expired" });

    expect(access.update).toHaveBeenCalledWith(
      expect.objectContaining({ shared_access: false }),
      { count: "exact" },
    );
    expect(access.lte).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(trackServer).toHaveBeenCalledWith("user-123", "ai_trial_expired", {});
  });

  it("denies without a duplicate event when another request won the expiry flip", async () => {
    const expired = accessRow({ granted_by: "trial", expires_at: PAST });
    mockDb(null, accessTableMock({ rows: [expired], flipCount: 0 }));

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_trial_expired" });
    expect(trackServer).not.toHaveBeenCalled();
  });

  it("denies with ai_trial_expired on an already-flipped trial tombstone", async () => {
    const tombstone = accessRow({ shared_access: false, granted_by: "trial", expires_at: PAST });
    const { access } = mockDb(null, accessTableMock({ rows: [tombstone] }));

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_trial_expired" });
    expect(access.update).not.toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it("keeps the key-specific code when a dead personal key coincides with an expired trial", async () => {
    const tombstone = accessRow({ shared_access: false, granted_by: "trial", expires_at: PAST });
    mockDb(activeKeyRow({ status: "invalid" }), accessTableMock({ rows: [tombstone] }));

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_key_invalid" });
  });

  it("still grants a trial whose window is open", async () => {
    const active = accessRow({ granted_by: "trial", expires_at: FUTURE });
    const { access } = mockDb(null, accessTableMock({ rows: [active] }));

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });
    expect(access.update).not.toHaveBeenCalled();
  });

  // ── runWithOpenAIFallback: user-key failures ──────────────────────────

  it("falls back to the app client on a user-key auth error when entitled", async () => {
    const failingClient = {
      responses: {
        create: vi.fn().mockRejectedValue(
          new AuthenticationError(401, { message: "invalid_api_key sk-proj-abc" }, "invalid", new Headers()),
        ),
      },
    } as unknown as OpenAI;
    const appClient = {
      responses: { create: vi.fn().mockResolvedValue({ output_text: "ok" }) },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: failingClient,
      source: "user",
    });
    const appSpy = vi.spyOn(routing, "getAppOpenAIClient").mockReturnValue(appClient);
    const accessSpy = vi
      .spyOn(routing, "resolveSharedAccess")
      .mockResolvedValue({ granted: true, trialExpired: false });

    const result = await openaiModule.runWithOpenAIFallback("user-123", (client) =>
      client.responses.create({ model: "gpt-5-mini", input: "hi" } as never),
    );

    expect(result).toEqual({ output_text: "ok" });
    expect(appClient.responses.create).toHaveBeenCalledTimes(1);

    getSpy.mockRestore();
    appSpy.mockRestore();
    accessSpy.mockRestore();
  });

  it("throws ai_key_invalid on a user-key auth error when NOT entitled", async () => {
    const failingClient = {
      responses: {
        create: vi.fn().mockRejectedValue(
          new AuthenticationError(401, { message: "invalid_api_key" }, "invalid", new Headers()),
        ),
      },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: failingClient,
      source: "user",
    });
    const accessSpy = vi
      .spyOn(routing, "resolveSharedAccess")
      .mockResolvedValue({ granted: false, trialExpired: false });

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", (client) =>
        client.responses.create({ model: "gpt-5-mini", input: "hi" } as never),
      ),
    ).rejects.toMatchObject({ code: "ai_key_invalid", status: 402 });

    getSpy.mockRestore();
    accessSpy.mockRestore();
  });

  it("throws ai_quota_exhausted on a user-key quota error when NOT entitled", async () => {
    const quotaErr = new APIError(429, { code: "insufficient_quota" }, "insufficient_quota", new Headers());
    const failingClient = {
      responses: { create: vi.fn().mockRejectedValue(quotaErr) },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: failingClient,
      source: "user",
    });
    const accessSpy = vi
      .spyOn(routing, "resolveSharedAccess")
      .mockResolvedValue({ granted: false, trialExpired: true });

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", (client) =>
        client.responses.create({ model: "gpt-5-mini", input: "hi" } as never),
      ),
    ).rejects.toMatchObject({ code: "ai_quota_exhausted", status: 402 });

    getSpy.mockRestore();
    accessSpy.mockRestore();
  });

  it("throws AiUnavailableError immediately when resolution fails (no key, no access)", async () => {
    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: false,
      code: "ai_no_key",
    });

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", async () => "unused"),
    ).rejects.toBeInstanceOf(AiUnavailableError);

    getSpy.mockRestore();
  });

  // ── runWithOpenAIFallback: shared-key failures ────────────────────────

  it("throws ai_unavailable when the shared key itself hits quota", async () => {
    const quotaErr = new APIError(429, { code: "insufficient_quota" }, "insufficient_quota", new Headers());
    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: openaiModule.getAppOpenAIClient(),
      source: "app",
    });

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", async () => {
        throw quotaErr;
      }),
    ).rejects.toMatchObject({ code: "ai_unavailable", status: 402 });

    getSpy.mockRestore();
  });

  it("scrubs sk- fragments from propagated (non-availability) errors", async () => {
    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: openaiModule.getAppOpenAIClient(),
      source: "app",
    });

    const err = new APIError(500, { message: "bad key sk-proj-abc123" }, "bad key sk-proj-abc123", new Headers());

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", async () => {
        throw err;
      }),
    ).rejects.toSatisfy((thrown: Error) => !thrown.message.includes("sk-"));

    getSpy.mockRestore();
  });

  it("marks active only for eligible existing statuses after a successful user-key call", async () => {
    const { keys } = mockDb(activeKeyRow());
    const userClient = {
      responses: { create: vi.fn().mockResolvedValue({ ok: true }) },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      ok: true,
      client: userClient,
      source: "user",
    });

    await openaiModule.runWithOpenAIFallback("user-123", async () => "ok");

    expect(keys.in).toHaveBeenCalledWith("status", ["active", "quota_exceeded"]);
    getSpy.mockRestore();
  });

  // ── Caching ───────────────────────────────────────────────────────────

  it("reuses the cached key within TTL with a lightweight status re-check", async () => {
    const { keys } = mockDb(activeKeyRow());

    await openaiModule.getOpenAIForUser("user-123");
    await openaiModule.getOpenAIForUser("user-123");

    expect(keys.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(1);
  });

  it("evicts the key cache on demand", async () => {
    const { keys } = mockDb(activeKeyRow());

    await openaiModule.getOpenAIForUser("user-123");
    openaiModule.evictOpenAIKeyCache("user-123");
    await openaiModule.getOpenAIForUser("user-123");

    expect(keys.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(2);
  });

  it("caches the shared-access state within TTL (no repeat entitlement reads)", async () => {
    const active = accessRow({ granted_by: "trial", expires_at: FUTURE });
    const { access } = mockDb(null, accessTableMock({ rows: [active] }));

    await openaiModule.getOpenAIForUser("user-123");
    await openaiModule.getOpenAIForUser("user-123");

    expect(access.maybeSingle).toHaveBeenCalledTimes(1);
  });
});
