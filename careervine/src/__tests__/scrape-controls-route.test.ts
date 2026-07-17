import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin scrape-controls routes (plan 36 + plan 41): schema contract for the
 * per-user PATCH and the bulk POST, including the discovery_enabled key.
 * These routes had no coverage before plan 41 added the third switch.
 */

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

let authedUser: Record<string, unknown> = {
  id: "admin-1",
  email: "admin@example.com",
  app_metadata: { role: "admin" },
};

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })),
    },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

const mockWriteAudit = vi.fn();
vi.mock("@/lib/admin", () => ({
  writeAudit: (...args: unknown[]) => mockWriteAudit(...args),
}));

import { PATCH } from "@/app/api/admin/users/[id]/scrape-controls/route";
import { POST as BULK } from "@/app/api/admin/scrape-controls/bulk/route";

function makeRequest(body: unknown) {
  return {
    method: "PATCH",
    nextUrl: new URL("http://localhost:3000/api/admin/users/u-1/scrape-controls"),
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
async function call(handler: any, body: unknown, params: Record<string, string> = { id: "u-1" }) {
  const response = await handler(makeRequest(body), { params: Promise.resolve(params) });
  return { status: response.status, data: await response.json() };
}

let lastUpdatePayload: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  authedUser = { id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } };
  lastUpdatePayload = undefined;

  const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "u-1", email: "u@example.com" }, error: null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: selectEq });
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const updateNot = vi.fn().mockResolvedValue({ count: 3, error: null });
  const update = vi.fn((payload: unknown) => {
    lastUpdatePayload = payload;
    return { eq: updateEq, not: updateNot };
  });
  mockFrom.mockReturnValue({ select, update });
});

describe("PATCH /api/admin/users/[id]/scrape-controls", () => {
  it("accepts the discovery_enabled key on its own", async () => {
    const { status, data } = await call(PATCH, { discovery_enabled: true });
    expect(status).toBe(200);
    expect(data.discovery_enabled).toBe(true);
    expect(lastUpdatePayload).toEqual({ discovery_enabled: true });
    expect(mockWriteAudit).toHaveBeenCalledWith(
      mockServiceClient,
      expect.objectContaining({ action: "set_scrape_controls", detail: { discovery_enabled: true } }),
    );
  });

  it("still accepts the original keys and combines them", async () => {
    const { status } = await call(PATCH, { apify_enrichment_enabled: false, discovery_enabled: false });
    expect(status).toBe(200);
    expect(lastUpdatePayload).toEqual({ apify_enrichment_enabled: false, discovery_enabled: false });
  });

  it("rejects an empty body (≥1 key contract)", async () => {
    const { status } = await call(PATCH, {});
    expect(status).toBe(400);
  });

  it("rejects non-admin callers", async () => {
    authedUser = { id: "user-9", app_metadata: {} };
    const { status } = await call(PATCH, { discovery_enabled: true });
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/scrape-controls/bulk", () => {
  it("applies discovery_enabled to all accounts and reports the count", async () => {
    const { status, data } = await call(BULK, { discovery_enabled: false });
    expect(status).toBe(200);
    expect(data.affected).toBe(3);
    expect(lastUpdatePayload).toEqual({ discovery_enabled: false });
    expect(mockWriteAudit).toHaveBeenCalledWith(
      mockServiceClient,
      expect.objectContaining({ action: "set_scrape_controls_all" }),
    );
  });

  it("rejects an empty body", async () => {
    const { status } = await call(BULK, {});
    expect(status).toBe(400);
  });
});
