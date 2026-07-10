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

vi.mock("@/lib/admin-notify", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/ai/request-access/route";
import { notifyOwner } from "@/lib/admin-notify";
import { trackServer } from "@/lib/analytics/server";

function makeRequest() {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/ai/request-access"),
    headers: new Headers(),
    json: vi.fn().mockRejectedValue(new Error("No body")),
  } as never;
}

function mockAccessTable(row: Record<string, unknown> | null, readError: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: readError });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  mockFrom.mockReturnValue({ select, upsert });
  return { upsert, maybeSingle };
}

async function call() {
  const response = await POST(makeRequest());
  return { status: response.status, data: await response.json() };
}

describe("POST /api/ai/request-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notifyOwner).mockResolvedValue(true);
  });

  it("records the request, notifies the owner, and tracks the event", async () => {
    const db = mockAccessTable({
      shared_access: false,
      expires_at: "2026-07-09T00:00:00Z",
      granted_by: "trial",
      access_requested_at: null,
    });

    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRequested: false });

    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-123",
        access_requested_at: expect.any(String),
      }),
      { onConflict: "user_id" },
    );
    expect(notifyOwner).toHaveBeenCalledWith(
      expect.stringContaining("test@example.com"),
      expect.stringContaining("user-123"),
    );
    expect(trackServer).toHaveBeenCalledWith("user-123", "ai_access_requested", {});
  });

  it("works for a user with no entitlement row at all", async () => {
    const db = mockAccessTable(null);
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRequested: false });
    expect(db.upsert).toHaveBeenCalled();
  });

  it("dedupes within the 7-day window without re-notifying", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const db = mockAccessTable({
      shared_access: false,
      expires_at: null,
      granted_by: "trial",
      access_requested_at: yesterday,
    });

    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRequested: true });
    expect(db.upsert).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it("re-notifies once the window has passed", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    mockAccessTable({
      shared_access: false,
      expires_at: null,
      granted_by: "trial",
      access_requested_at: eightDaysAgo,
    });

    const { data } = await call();
    expect(data).toEqual({ ok: true, alreadyRequested: false });
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the owner email fails (fail-soft)", async () => {
    mockAccessTable(null);
    vi.mocked(notifyOwner).mockResolvedValue(false);

    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRequested: false });
    expect(trackServer).toHaveBeenCalledWith("user-123", "ai_access_requested", {});
  });

  it("returns 500 when the entitlement read fails", async () => {
    mockAccessTable(null, { message: "boom" });
    const { status } = await call();
    expect(status).toBe(500);
  });
});
