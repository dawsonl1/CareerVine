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

import * as openaiModule from "@/lib/openai";
import { AiUnavailableError } from "@/lib/openai";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { decryptSecret } from "@/lib/crypto";

const routing = openaiModule.openaiRoutingInternals!;

/**
 * A permissive chainable that satisfies every query shape used by routing:
 *   select().eq().eq().maybeSingle()      (user_api_keys read)
 *   select().eq().maybeSingle()           (user_ai_access read)
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

function mockDb(
  keyRow: Record<string, unknown> | null,
  accessRow: Record<string, unknown> | null = null,
) {
  const keys = tableMock(keyRow);
  const access = tableMock(accessRow);
  mockFrom.mockImplementation((table: string) =>
    table === "user_ai_access" ? access.chain : keys.chain,
  );
  return { keys, access };
}

function activeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    encrypted_key: "enc:sk-user-key-1234567890",
    status: "active",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

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

  it("fails with ai_no_key when no key and no shared access", async () => {
    mockDb(null, null);
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_no_key" });
  });

  it("fails with ai_key_invalid when the key is invalid and no shared access", async () => {
    mockDb(activeKeyRow({ status: "invalid" }), null);
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_key_invalid" });
  });

  it("fails with ai_quota_exhausted when quota is spent (in cooldown) and no shared access", async () => {
    mockDb(activeKeyRow({ status: "quota_exceeded" }), null); // fresh updated_at → still in cooldown
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_quota_exhausted" });
  });

  it("fails with ai_key_invalid when the key can't be decrypted and no shared access", async () => {
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error("corrupt");
    });
    mockDb(activeKeyRow(), null);
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: false, code: "ai_key_invalid" });
  });

  // ── Resolution: no usable personal key, ENTITLED → shared app client ───

  it("uses the app client when no key but shared access is granted", async () => {
    mockDb(null, { shared_access: true });
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved).toMatchObject({ ok: true, source: "app" });
  });

  it("uses the app client when the key is invalid but shared access is granted", async () => {
    mockDb(activeKeyRow({ status: "invalid" }), { shared_access: true });
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
    const accessSpy = vi.spyOn(routing, "hasSharedAccess").mockResolvedValue(true);

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
    const accessSpy = vi.spyOn(routing, "hasSharedAccess").mockResolvedValue(false);

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
    const accessSpy = vi.spyOn(routing, "hasSharedAccess").mockResolvedValue(false);

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
});
