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
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { decryptSecret } from "@/lib/crypto";

const routing = openaiModule.openaiRoutingInternals!;

/**
 * Table-aware mock: user_api_keys returns the key row; users returns the
 * account's ai_fallback_policy (default 'shared' = legacy behavior).
 */
function mockDbRow(
  row: Record<string, unknown> | null,
  opts: { policy?: "cutoff" | "shared" } = {},
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const policyMaybeSingle = vi.fn().mockResolvedValue({
    data: { ai_fallback_policy: opts.policy ?? "shared" },
    error: null,
  });

  mockFrom.mockImplementation((table: string) => {
    const single = table === "users" ? policyMaybeSingle : maybeSingle;
    const eqProvider = vi.fn().mockReturnValue({ maybeSingle: single });
    const eqUser = vi
      .fn()
      .mockReturnValue({ eq: eqProvider, maybeSingle: single });
    const select = vi.fn().mockReturnValue({ eq: eqUser });
    const updateEqProvider = vi.fn().mockResolvedValue({});
    const updateEqUser = vi.fn().mockReturnValue({ eq: updateEqProvider });
    const update = vi.fn().mockReturnValue({ eq: updateEqUser });
    return { select, update };
  });
  return { maybeSingle, policyMaybeSingle };
}

describe("openai routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockImplementation(() => mockServiceClient as never);
    process.env.OPENAI_API_KEY = "sk-app-key";
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    openaiModule.evictOpenAIKeyCache("user-123");
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  it("uses app client when no row exists", async () => {
    mockDbRow(null);
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("uses user key when row is active", async () => {
    mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("user");
  });

  it("uses app client for invalid status", async () => {
    mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "invalid",
      updated_at: new Date().toISOString(),
    });

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("retries quota_exceeded keys after cooldown", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "quota_exceeded",
      updated_at: old,
    });

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("user");
  });

  it("falls back on user-key auth error", async () => {
    const failingClient = {
      responses: {
        create: vi.fn().mockRejectedValue(
          new AuthenticationError(401, { message: "invalid_api_key sk-proj-abc" }, "invalid", new Headers()),
        ),
      },
    } as unknown as OpenAI;

    const appClient = {
      responses: {
        create: vi.fn().mockResolvedValue({ output_text: "ok" }),
      },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      client: failingClient,
      source: "user",
      policy: "shared",
    });
    const appSpy = vi.spyOn(routing, "getAppOpenAIClient").mockReturnValue(appClient);

    const result = await openaiModule.runWithOpenAIFallback("user-123", (client) =>
      client.responses.create({ model: "gpt-5-mini", input: "hi" } as never),
    );

    expect(result).toEqual({ output_text: "ok" });
    expect(appClient.responses.create).toHaveBeenCalledTimes(1);

    getSpy.mockRestore();
    appSpy.mockRestore();
  });

  it("scrubs sk- fragments from propagated errors", async () => {
    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      client: openaiModule.getAppOpenAIClient(),
      source: "app",
      policy: "shared",
    });

    const err = new APIError(
      500,
      { message: "bad key sk-proj-abc123" },
      "bad key sk-proj-abc123",
      new Headers(),
    );

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", async () => {
        throw err;
      }),
    ).rejects.toSatisfy((thrown: Error) => !thrown.message.includes("sk-"));

    getSpy.mockRestore();
  });

  it("falls back when service client construction throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockImplementationOnce(() => {
      throw new Error("missing service role key");
    });

    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("reuses cached key within TTL with a lightweight status re-check", async () => {
    const rowUpdatedAt = new Date().toISOString();
    const lookup = mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "active",
      updated_at: rowUpdatedAt,
    });

    await openaiModule.getOpenAIForUser("user-123");
    await openaiModule.getOpenAIForUser("user-123");

    expect(lookup.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(1);
  });

  it("evicts cache on demand", async () => {
    const lookup = mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    await openaiModule.getOpenAIForUser("user-123");
    openaiModule.evictOpenAIKeyCache("user-123");
    await openaiModule.getOpenAIForUser("user-123");

    expect(lookup.maybeSingle).toHaveBeenCalledTimes(2);
    expect(decryptSecret).toHaveBeenCalledTimes(2);
  });

  it("falls back to app client when cached key was deleted", async () => {
    const rowUpdatedAt = new Date().toISOString();
    const lookup = mockDbRow({
      encrypted_key: "enc:sk-user-key-1234567890",
      status: "active",
      updated_at: rowUpdatedAt,
    });

    await openaiModule.getOpenAIForUser("user-123");
    expect(lookup.maybeSingle).toHaveBeenCalledTimes(1);

    lookup.maybeSingle.mockResolvedValue({ data: null, error: null });
    const resolved = await openaiModule.getOpenAIForUser("user-123");

    expect(resolved.source).toBe("app");
    expect(lookup.maybeSingle).toHaveBeenCalledTimes(3);
  });

  it("marks active only for eligible existing statuses", async () => {
    const inFilter = vi.fn().mockResolvedValue({});
    const updateIn = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: inFilter,
        }),
      }),
    });
    mockFrom.mockReturnValue({ update: updateIn });

    const userClient = {
      responses: { create: vi.fn().mockResolvedValue({ ok: true }) },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      client: userClient,
      source: "user",
      policy: "shared",
    });

    await openaiModule.runWithOpenAIFallback("user-123", async () => "ok");

    expect(inFilter).toHaveBeenCalledWith("status", ["active", "quota_exceeded"]);
    getSpy.mockRestore();
  });
});

// ── Fallback-policy matrix (plan 32 §5) ────────────────────────────────
// | key state              | shared      | cutoff                 |
// | valid                  | own key     | own key                |
// | missing                | shared key  | AI_NO_KEY (402)        |
// | invalid                | shared key  | AI_KEY_INVALID (402)   |
// | quota (in cooldown)    | shared key  | AI_QUOTA_EXCEEDED (402)|
// | mid-call 401 / quota   | retry shared| typed 402, no retry    |

describe("ai fallback policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockImplementation(() => mockServiceClient as never);
    process.env.OPENAI_API_KEY = "sk-app-key";
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    openaiModule.evictOpenAIKeyCache("user-123");
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  async function expectUnavailable(code: string) {
    try {
      await openaiModule.getOpenAIForUser("user-123");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(openaiModule.AiUnavailableError);
      expect((err as openaiModule.AiUnavailableError).code).toBe(code);
      expect((err as openaiModule.AiUnavailableError).status).toBe(402);
    }
  }

  it("cutoff + no key → AI_NO_KEY", async () => {
    mockDbRow(null, { policy: "cutoff" });
    await expectUnavailable("AI_NO_KEY");
  });

  it("cutoff + invalid key → AI_KEY_INVALID", async () => {
    mockDbRow(
      {
        encrypted_key: "enc:sk-user-key-1234567890",
        status: "invalid",
        updated_at: new Date().toISOString(),
      },
      { policy: "cutoff" },
    );
    await expectUnavailable("AI_KEY_INVALID");
  });

  it("cutoff + quota_exceeded (in cooldown) → AI_QUOTA_EXCEEDED", async () => {
    mockDbRow(
      {
        encrypted_key: "enc:sk-user-key-1234567890",
        status: "quota_exceeded",
        updated_at: new Date().toISOString(),
      },
      { policy: "cutoff" },
    );
    await expectUnavailable("AI_QUOTA_EXCEEDED");
  });

  it("cutoff + valid key → still uses the user's own key", async () => {
    mockDbRow(
      {
        encrypted_key: "enc:sk-user-key-1234567890",
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { policy: "cutoff" },
    );
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("user");
    expect(resolved.policy).toBe("cutoff");
  });

  it("shared policy preserves legacy fallback on every miss", async () => {
    mockDbRow(null, { policy: "shared" });
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("policy read failure fails open to shared (availability over policy)", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === "users") throw new Error("users table unreachable");
      const eqProvider = vi.fn().mockReturnValue({ maybeSingle });
      const eqUser = vi.fn().mockReturnValue({ eq: eqProvider });
      return { select: vi.fn().mockReturnValue({ eq: eqUser }) };
    });
    const resolved = await openaiModule.getOpenAIForUser("user-123");
    expect(resolved.source).toBe("app");
  });

  it("mid-call 401 under cutoff throws typed 402 and never touches the shared key", async () => {
    const failingClient = {
      responses: {
        create: vi.fn().mockRejectedValue({ status: 401 }),
      },
    } as unknown as OpenAI;
    const appClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      client: failingClient,
      source: "user",
      policy: "cutoff",
    });
    const appSpy = vi.spyOn(routing, "getAppOpenAIClient").mockReturnValue(appClient);
    mockDbRow(null); // for markKeyStatus writes

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", (client) =>
        client.responses.create({} as never),
      ),
    ).rejects.toMatchObject({ code: "AI_KEY_INVALID", status: 402 });
    expect(appClient.responses.create).not.toHaveBeenCalled();

    getSpy.mockRestore();
    appSpy.mockRestore();
  });

  it("mid-call quota under cutoff throws typed 402 and never touches the shared key", async () => {
    const failingClient = {
      responses: {
        create: vi.fn().mockRejectedValue({ code: "insufficient_quota" }),
      },
    } as unknown as OpenAI;
    const appClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;

    const getSpy = vi.spyOn(routing, "getOpenAIForUser").mockResolvedValue({
      client: failingClient,
      source: "user",
      policy: "cutoff",
    });
    const appSpy = vi.spyOn(routing, "getAppOpenAIClient").mockReturnValue(appClient);
    mockDbRow(null);

    await expect(
      openaiModule.runWithOpenAIFallback("user-123", (client) =>
        client.responses.create({} as never),
      ),
    ).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED", status: 402 });
    expect(appClient.responses.create).not.toHaveBeenCalled();

    getSpy.mockRestore();
    appSpy.mockRestore();
  });
});
