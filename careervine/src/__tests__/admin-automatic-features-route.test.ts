import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-103: the admin automatic-features toggle. Verifies the admin gate, the
 * count-based 404 when the account has no gmail_connections row, and the audit
 * write on success.
 */

let authedUser: Record<string, unknown> | null = { id: "admin-1", app_metadata: { role: "admin" } };
let updateResult: { count: number | null; error: unknown } = { count: 1, error: null };
const writeAuditMock = vi.fn();
const eqMock = vi.fn(() => Promise.resolve(updateResult));
const updateMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ update: updateMock }));

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({ from: fromMock })),
}));

vi.mock("@/lib/admin", () => ({
  writeAudit: (...args: unknown[]) => writeAuditMock(...args),
}));

import { PATCH } from "@/app/api/admin/users/[id]/automatic-features/route";

function makeRequest(body: unknown) {
  return {
    method: "PATCH",
    nextUrl: new URL("http://localhost:3000/api/admin/users/u-1/automatic-features"),
    url: "http://localhost:3000/api/admin/users/u-1/automatic-features",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as never;
}

async function call(body: unknown) {
  const res = await PATCH(makeRequest(body), { params: Promise.resolve({ id: "u-1" }) });
  return { status: res.status, data: await res.json() };
}

describe("PATCH /api/admin/users/[id]/automatic-features (CAR-103)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "admin-1", app_metadata: { role: "admin" } };
    updateResult = { count: 1, error: null };
  });

  it("403s a non-admin (before any write)", async () => {
    authedUser = { id: "u-2", app_metadata: {} };
    const { status } = await call({ automatic_features_enabled: true });
    expect(status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("404s when the account has no gmail_connections row (count 0)", async () => {
    updateResult = { count: 0, error: null };
    const { status } = await call({ automatic_features_enabled: true });
    expect(status).toBe(404);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("enables the entitlement (exact count) and writes an audit row", async () => {
    const { status, data } = await call({ automatic_features_enabled: true });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(
      { automatic_features_enabled: true },
      { count: "exact" },
    );
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "set_automatic_features",
        targetUserId: "u-1",
        adminId: "admin-1",
      }),
    );
  });

  it("400s an invalid body (missing flag)", async () => {
    const { status } = await call({});
    expect(status).toBe(400);
  });
});
