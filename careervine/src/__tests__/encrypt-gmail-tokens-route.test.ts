import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/encrypt-gmail-tokens/route";
import { encryptOAuthToken, decryptOAuthToken } from "@/lib/oauth-helpers";

const TOKEN = "admin-secret";

function makeReq(authorized = true) {
  return new NextRequest("http://localhost/api/admin/encrypt-gmail-tokens", {
    method: "POST",
    headers: authorized ? { authorization: `Bearer ${TOKEN}` } : {},
  });
}

interface ConnRow {
  id: number;
  access_token: string;
  refresh_token: string;
}

/**
 * Fake gmail_connections: select returns the rows; update captures the payload
 * and resolves with the given count per row id (default 1 = CAS hit).
 */
function mockDb(rows: ConnRow[], countById: Record<number, number> = {}) {
  const updates: { id: unknown; payload: Record<string, string> }[] = [];
  mockFrom.mockImplementation(() => ({
    select: vi.fn().mockResolvedValue({ data: rows, error: null }),
    update: (payload: Record<string, string>) => {
      const eqArgs: unknown[] = [];
      const chain = {
        eq: (_col: string, value: unknown) => {
          eqArgs.push(value);
          return chain;
        },
        then: (resolve: (v: { error: null; count: number }) => void) => {
          const id = eqArgs[0] as number; // first .eq() is on id
          updates.push({ id, payload });
          resolve({ error: null, count: countById[id] ?? 1 });
        },
      };
      return chain;
    },
  }));
  return { updates };
}

describe("POST /api/admin/encrypt-gmail-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUNDLE_ADMIN_TOKEN = TOKEN;
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  it("401s without a valid admin token", async () => {
    mockDb([]);
    const res = await POST(makeReq(false));
    expect(res.status).toBe(401);
  });

  it("encrypts plaintext rows and reports counts", async () => {
    const { updates } = mockDb([
      { id: 1, access_token: "ya29.plain-at", refresh_token: "1//plain-rt" },
    ]);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      encrypted: 1,
      alreadyEncrypted: 0,
      skippedRaced: 0,
    });
    expect(updates).toHaveLength(1);
    const { payload } = updates[0];
    expect(decryptOAuthToken(payload.access_token)).toBe("ya29.plain-at");
    expect(decryptOAuthToken(payload.refresh_token)).toBe("1//plain-rt");
    expect(payload.access_token.startsWith("v1.")).toBe(true);
    expect(payload.refresh_token.startsWith("v1.")).toBe(true);
  });

  it("skips rows that are already encrypted (idempotent re-run)", async () => {
    const { updates } = mockDb([
      {
        id: 1,
        access_token: encryptOAuthToken("ya29.at"),
        refresh_token: encryptOAuthToken("1//rt"),
      },
    ]);
    const res = await POST(makeReq());
    await expect(res.json()).resolves.toEqual({
      encrypted: 0,
      alreadyEncrypted: 1,
      skippedRaced: 0,
    });
    expect(updates).toHaveLength(0);
  });

  it("encrypts only the plaintext half of a partially encrypted row", async () => {
    const encryptedRt = encryptOAuthToken("1//rt");
    const { updates } = mockDb([
      { id: 1, access_token: "ya29.plain-at", refresh_token: encryptedRt },
    ]);
    await POST(makeReq());
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.access_token.startsWith("v1.")).toBe(true);
    expect(updates[0].payload).not.toHaveProperty("refresh_token");
  });

  it("counts a CAS miss (concurrent refresh) as skippedRaced, not encrypted", async () => {
    mockDb(
      [{ id: 1, access_token: "ya29.plain-at", refresh_token: "1//plain-rt" }],
      { 1: 0 }, // update matched no rows — tokens changed under us
    );
    const res = await POST(makeReq());
    await expect(res.json()).resolves.toEqual({
      encrypted: 0,
      alreadyEncrypted: 0,
      skippedRaced: 1,
    });
  });
});
