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

// The routing lib pulls in the Deepgram SDK; stub it so imports are hermetic.
vi.mock("@deepgram/sdk", () => ({
  DeepgramClient: class DeepgramClient {
    constructor() {}
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET, PUT, DELETE } from "@/app/api/settings/deepgram-key/route";
import { evictDeepgramKeyCache } from "@/lib/deepgram";

// 40 lowercase hex characters — a well-formed Deepgram key.
const VALID_KEY = "0123456789abcdef0123456789abcdef01234567";

function makeRequest(method: string, body?: unknown) {
  return {
    method,
    nextUrl: new URL("http://localhost:3000/api/settings/deepgram-key"),
    headers: new Headers(),
    json:
      body !== undefined
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

describe("settings/deepgram-key route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    evictDeepgramKeyCache("user-123");
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("GET returns hasKey false when no row", async () => {
    mockSelectRow(null);
    const { status, data } = await call(GET, makeRequest("GET"));
    expect(status).toBe(200);
    expect(data).toEqual({ hasKey: false });
  });

  it("GET returns metadata only", async () => {
    mockSelectRow({
      key_last4: "4567",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_used_at: null,
    });

    const { status, data, text } = await call(GET, makeRequest("GET"));
    expect(status).toBe(200);
    expect(data.hasKey).toBe(true);
    expect(data.last4).toBe("4567");
    expect(text).not.toContain(VALID_KEY);
    expect(text).not.toContain("enc:");
  });

  it("PUT rejects invalid key format", async () => {
    const { status } = await call(PUT, makeRequest("PUT", { apiKey: "not-a-key" }));
    expect(status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PUT rejects a key Deepgram returns 401 for, without echoing it", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { status, data, text } = await call(PUT, makeRequest("PUT", { apiKey: VALID_KEY }));
    expect(status).toBe(400);
    expect(data.error).toContain("rejected");
    expect(text).not.toContain(VALID_KEY);
  });

  it("PUT rejects a key with no Deepgram credit", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 402 });
    const { status, data } = await call(PUT, makeRequest("PUT", { apiKey: VALID_KEY }));
    expect(status).toBe(400);
    expect(data.error).toContain("credit");
  });

  it("PUT saves the encrypted key with provider=deepgram", async () => {
    const db = mockSelectRow({
      key_last4: "4567",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_used_at: null,
    });

    const { status, data } = await call(PUT, makeRequest("PUT", { apiKey: VALID_KEY }));

    expect(status).toBe(200);
    expect(data.hasKey).toBe(true);
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepgram",
        encrypted_key: `enc:${VALID_KEY}`,
        key_last4: "4567",
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
