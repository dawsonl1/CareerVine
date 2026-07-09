import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/ai-access/route";

const TOKEN = "admin-secret";

function makeReq(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/admin/ai-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Capture the last upsert payload; optionally stub a users-by-email lookup. */
function mockDb(opts: { userRow?: { id: string } | null; upsertError?: unknown } = {}) {
  const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: opts.userRow ?? null, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  mockFrom.mockImplementation((table: string) =>
    table === "users" ? { select } : { upsert },
  );
  return { upsert };
}

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("POST /api/admin/ai-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUNDLE_ADMIN_TOKEN = TOKEN;
  });

  it("401s without a valid admin token", async () => {
    mockDb();
    const res = await POST(makeReq({ userId: VALID_UUID, sharedAccess: true }, false));
    expect(res.status).toBe(401);
  });

  it("400s when neither userId nor email is provided", async () => {
    mockDb();
    const res = await POST(makeReq({ sharedAccess: true }));
    expect(res.status).toBe(400);
  });

  it("grants shared access by userId and stamps granted_at", async () => {
    const { upsert } = mockDb();
    const res = await POST(makeReq({ userId: VALID_UUID, sharedAccess: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: VALID_UUID, sharedAccess: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [payload] = upsert.mock.calls[0];
    expect(payload).toMatchObject({ user_id: VALID_UUID, shared_access: true });
    expect(payload.granted_at).toBeTruthy();
  });

  it("revokes access and clears granted_at", async () => {
    const { upsert } = mockDb();
    const res = await POST(makeReq({ userId: VALID_UUID, sharedAccess: false }));
    expect(res.status).toBe(200);
    const [payload] = upsert.mock.calls[0];
    expect(payload).toMatchObject({ user_id: VALID_UUID, shared_access: false, granted_at: null });
  });

  it("resolves the user by email", async () => {
    const { upsert } = mockDb({ userRow: { id: VALID_UUID } });
    const res = await POST(makeReq({ email: "dawson@example.com", sharedAccess: true }));
    expect(res.status).toBe(200);
    expect(upsert.mock.calls[0][0]).toMatchObject({ user_id: VALID_UUID });
  });

  it("404s when the email matches no user", async () => {
    mockDb({ userRow: null });
    const res = await POST(makeReq({ email: "nobody@example.com", sharedAccess: true }));
    expect(res.status).toBe(404);
  });
});
