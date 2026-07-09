import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-123", email: "test@example.com" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: vi.fn((value: string) => `enc:${value}`),
  CryptoError: class CryptoError extends Error {},
}));

const mockResponsesCreate = vi.fn();

vi.mock("openai", () => {
  // Mirrors the real openai APIError closely enough for the route's error
  // handling: code derives from the error body (the real property is
  // readonly, so tests must pass it through the constructor, not assign it).
  class APIError extends Error {
    status: number;
    code?: string;
    constructor(status: number, error: unknown, message?: string) {
      super(message || "API error");
      this.status = status;
      this.code = (error as { code?: string } | undefined)?.code;
    }
  }

  class AuthenticationError extends APIError {
    constructor(status = 401, error: unknown = { code: "invalid_api_key" }, message = "invalid") {
      super(status, error, message);
    }
  }

  return {
    default: class OpenAI {
      responses = { create: mockResponsesCreate };
      constructor() {}
    },
    APIError,
    AuthenticationError,
  };
});

import { GET, PUT, DELETE } from "@/app/api/settings/openai-key/route";
import { evictOpenAIKeyCache } from "@/lib/openai";

function makeRequest(method: string, body?: unknown) {
  return {
    method,
    nextUrl: new URL("http://localhost:3000/api/settings/openai-key"),
    headers: new Headers(),
    json: body !== undefined
      ? vi.fn().mockResolvedValue(body)
      : vi.fn().mockRejectedValue(new Error("No body")),
  } as any;
}

async function call(handler: any, request: any) {
  const response = await handler(request);
  const data = await response.json();
  return { status: response.status, data, text: JSON.stringify(data) };
}

function mockSelectRow(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const single = vi.fn().mockResolvedValue({ data: row, error: null });
  const eqProvider = vi.fn().mockReturnValue({ maybeSingle, single });
  const eqUser = vi.fn().mockReturnValue({ eq: eqProvider });
  const select = vi.fn().mockReturnValue({ eq: eqUser });
  const deleteEqProvider = vi.fn().mockResolvedValue({});
  const deleteEqUser = vi.fn().mockReturnValue({ eq: deleteEqProvider });
  const del = vi.fn().mockReturnValue({ eq: deleteEqUser });
  const upsert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) });
  mockFrom.mockReturnValue({ select, upsert, delete: del });
  return { maybeSingle, single, upsert, del };
}

describe("settings/openai-key route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    evictOpenAIKeyCache("user-123");
    mockResponsesCreate.mockResolvedValue({ output_text: "hello" });
  });

  it("GET returns hasKey false when no row", async () => {
    mockSelectRow(null);
    const { status, data } = await call(GET, makeRequest("GET"));
    expect(status).toBe(200);
    expect(data).toEqual({ hasKey: false });
  });

  it("GET returns metadata only", async () => {
    mockSelectRow({
      key_last4: "Ab3d",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_used_at: null,
    });

    const { status, data, text } = await call(GET, makeRequest("GET"));
    expect(status).toBe(200);
    expect(data.hasKey).toBe(true);
    expect(data.last4).toBe("Ab3d");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("enc:");
  });

  it("PUT rejects invalid key format", async () => {
    const { status } = await call(PUT, makeRequest("PUT", { apiKey: "not-a-key" }));
    expect(status).toBe(400);
  });

  it("PUT rejects OpenAI 401 without echoing key", async () => {
    // Runtime is the mock above; the type is the real class, whose
    // constructor takes (status, error, message, headers).
    const { AuthenticationError } = await import("openai");
    mockResponsesCreate.mockRejectedValueOnce(
      new AuthenticationError(401, { code: "invalid_api_key" }, "invalid", new Headers()),
    );
    const { status, data, text } = await call(
      PUT,
      makeRequest("PUT", { apiKey: "sk-proj-secret-key-1234567890" }),
    );
    expect(status).toBe(400);
    expect(data.error).toContain("rejected");
    expect(text).not.toContain("sk-proj-secret");
  });

  it("PUT rejects insufficient_quota", async () => {
    const { APIError } = await import("openai");
    // code is readonly on the real type — pass it via the error body, which
    // both the real class and the mock derive it from.
    const err = new APIError(429, { message: "quota", code: "insufficient_quota" }, "quota", undefined);
    mockResponsesCreate.mockRejectedValueOnce(err);
    const { status, data } = await call(
      PUT,
      makeRequest("PUT", { apiKey: "sk-proj-secret-key-1234567890" }),
    );
    expect(status).toBe(400);
    expect(data.error).toContain("quota");
  });

  it("PUT saves encrypted key", async () => {
    const db = mockSelectRow({
      key_last4: "7890",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_used_at: null,
    });

    const { status, data } = await call(
      PUT,
      makeRequest("PUT", { apiKey: "sk-proj-secret-key-1234567890" }),
    );

    expect(status).toBe(200);
    expect(data.hasKey).toBe(true);
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_key: "enc:sk-proj-secret-key-1234567890",
        key_last4: "7890",
        status: "active",
      }),
    );
  });

  it("DELETE removes key", async () => {
    const db = mockSelectRow(null);
    const { status, data } = await call(DELETE, makeRequest("DELETE"));
    expect(status).toBe(200);
    expect(data).toEqual({ hasKey: false });
    expect(db.del).toHaveBeenCalled();
  });
});
