import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret: vi.fn((value: string) => value.replace("enc:", "")),
  CryptoError: class CryptoError extends Error {},
}));

// Stub the Deepgram SDK so buildClient just records the api key.
vi.mock("@deepgram/sdk", () => ({
  DeepgramClient: class DeepgramClient {
    apiKey: string;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
  },
}));

import * as deepgramModule from "@/lib/deepgram";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { decryptSecret } from "@/lib/crypto";

const routing = deepgramModule.deepgramRoutingInternals!;

type StubClient = { apiKey: string };

function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

function mockDbRow(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const eqProvider = vi.fn().mockReturnValue({ maybeSingle });
  const eqUser = vi.fn().mockReturnValue({ eq: eqProvider });
  const select = vi.fn().mockReturnValue({ eq: eqUser });
  const updateEqProvider = vi.fn().mockResolvedValue({});
  const updateEqUser = vi.fn().mockReturnValue({ eq: updateEqProvider });
  const update = vi.fn().mockReturnValue({ eq: updateEqUser });
  mockFrom.mockReturnValue({ select, update });
  return { maybeSingle, update };
}

describe("deepgram routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockImplementation(() => mockServiceClient as never);
    process.env.DEEPGRAM_API_KEY = "dg-app-key";
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    deepgramModule.evictDeepgramKeyCache("user-123");
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  it("uses app key when no row exists", async () => {
    mockDbRow(null);
    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("app");
    expect((resolved.client as unknown as StubClient).apiKey).toBe("dg-app-key");
  });

  it("uses user key when row is active", async () => {
    mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("user");
    expect((resolved.client as unknown as StubClient).apiKey).toBe("dg-user-key");
  });

  it("uses app key for invalid status", async () => {
    mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "invalid",
      updated_at: new Date().toISOString(),
    });

    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("uses app key for quota_exceeded within cooldown", async () => {
    mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "quota_exceeded",
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("retries quota_exceeded keys after the 24h cooldown", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "quota_exceeded",
      updated_at: old,
    });

    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("user");
  });

  it("falls back to the shared key on a user-key auth error", async () => {
    const failing = { apiKey: "dg-user-key" } as StubClient;

    const getSpy = vi.spyOn(routing, "getDeepgramForUser").mockResolvedValue({
      client: failing as never,
      source: "user",
    });
    const appSpy = vi.spyOn(routing, "getAppDeepgramKey").mockReturnValue("dg-app-key");

    const result = await deepgramModule.runWithDeepgramFallback("user-123", async (client) => {
      if ((client as unknown as StubClient).apiKey === "dg-user-key") throw httpError(401);
      return "ok";
    });

    expect(result).toBe("ok");
    getSpy.mockRestore();
    appSpy.mockRestore();
  });

  it("falls back on a user-key quota error (402)", async () => {
    const failing = { apiKey: "dg-user-key" } as StubClient;
    const getSpy = vi.spyOn(routing, "getDeepgramForUser").mockResolvedValue({
      client: failing as never,
      source: "user",
    });
    const appSpy = vi.spyOn(routing, "getAppDeepgramKey").mockReturnValue("dg-app-key");

    const result = await deepgramModule.runWithDeepgramFallback("user-123", async (client) => {
      if ((client as unknown as StubClient).apiKey === "dg-user-key") throw httpError(402);
      return "ok";
    });

    expect(result).toBe("ok");
    getSpy.mockRestore();
    appSpy.mockRestore();
  });

  it("throws a coded deepgram_no_credit error when the shared key is also out of credit", async () => {
    const getSpy = vi.spyOn(routing, "getDeepgramForUser").mockResolvedValue({
      client: { apiKey: "dg-app-key" } as never,
      source: "app",
    });

    await expect(
      deepgramModule.runWithDeepgramFallback("user-123", async () => {
        throw httpError(429);
      }),
    ).rejects.toMatchObject({ code: "deepgram_no_credit", status: 503 });

    getSpy.mockRestore();
  });

  it("reuses cached key within TTL and decrypts once", async () => {
    const lookup = mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    await deepgramModule.getDeepgramForUser("user-123");
    await deepgramModule.getDeepgramForUser("user-123");

    expect(lookup.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(1);
  });

  it("evicts cache on demand", async () => {
    const lookup = mockDbRow({
      encrypted_key: "enc:dg-user-key",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    await deepgramModule.getDeepgramForUser("user-123");
    deepgramModule.evictDeepgramKeyCache("user-123");
    await deepgramModule.getDeepgramForUser("user-123");

    expect(lookup.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(2);
  });

  it("falls back to app key when service client construction throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockImplementationOnce(() => {
      throw new Error("missing service role key");
    });

    const resolved = await deepgramModule.getDeepgramForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("throws a coded deepgram_unavailable error when no shared key is configured", () => {
    delete process.env.DEEPGRAM_API_KEY;
    expect(() => deepgramModule.getAppDeepgramKey()).toThrowError();
    try {
      deepgramModule.getAppDeepgramKey();
    } catch (err) {
      expect((err as { code?: string }).code).toBe("deepgram_unavailable");
    }
  });
});
