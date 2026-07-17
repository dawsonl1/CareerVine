import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-141 (R1.5a): the admin recovery link must point at /auth/confirm with
 * the hashed token, never at GoTrue's implicit-grant action_link — verifyOtp
 * mints the session server-side so /reset-password can rely on one session
 * check. Regressing to action_link would break the simplified page.
 */

let authedUser: Record<string, unknown> | null = {
  id: "admin-1",
  app_metadata: { role: "admin" },
};
const getUserByIdMock = vi.fn();
const generateLinkMock = vi.fn();
const updateUserByIdMock = vi.fn();
const writeAuditMock = vi.fn();
const revokeUserSessionsMock = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    auth: {
      admin: {
        getUserById: (...args: unknown[]) => getUserByIdMock(...args),
        generateLink: (...args: unknown[]) => generateLinkMock(...args),
        updateUserById: (...args: unknown[]) => updateUserByIdMock(...args),
      },
    },
  })),
}));

vi.mock("@/lib/admin", () => ({
  writeAudit: (...args: unknown[]) => writeAuditMock(...args),
}));

vi.mock("@/lib/admin-actions", () => ({
  revokeUserSessions: (...args: unknown[]) => revokeUserSessionsMock(...args),
}));

import { POST } from "@/app/api/admin/users/[id]/password/route";

function makeRequest(body: unknown) {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/admin/users/u-1/password"),
    url: "http://localhost:3000/api/admin/users/u-1/password",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as never;
}

async function call(body: unknown) {
  const res = await POST(makeRequest(body), { params: Promise.resolve({ id: "u-1" }) });
  return { status: res.status, data: await res.json() };
}

describe("POST /api/admin/users/[id]/password mode=link (CAR-141)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "admin-1", app_metadata: { role: "admin" } };
    getUserByIdMock.mockResolvedValue({
      data: { user: { id: "u-1", email: "target@example.com" } },
      error: null,
    });
    generateLinkMock.mockResolvedValue({
      data: {
        properties: {
          hashed_token: "pkce_abc123",
          action_link: "https://project.supabase.co/auth/v1/verify?token=legacy#access_token=x",
        },
      },
      error: null,
    });
  });

  it("returns an /auth/confirm link built from hashed_token, not the legacy action_link", async () => {
    const { status, data } = await call({ mode: "link" });

    expect(status).toBe(200);
    expect(data.actionLink).toBe(
      "http://localhost:3000/auth/confirm?token_hash=pkce_abc123&type=recovery&next=/reset-password",
    );
    expect(generateLinkMock).toHaveBeenCalledWith({
      type: "recovery",
      email: "target@example.com",
    });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminId: "admin-1",
        targetUserId: "u-1",
        action: "password_reset_link",
      }),
    );
  });

  it("returns a null link when GoTrue omits hashed_token", async () => {
    generateLinkMock.mockResolvedValue({
      data: { properties: { action_link: "https://legacy.example" } },
      error: null,
    });
    const { status, data } = await call({ mode: "link" });

    expect(status).toBe(200);
    expect(data.actionLink).toBeNull();
  });

  it("400s when generateLink fails", async () => {
    generateLinkMock.mockResolvedValue({
      data: null,
      error: { message: "rate limited" },
    });
    const { status } = await call({ mode: "link" });

    expect(status).toBe(400);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("403s a non-admin before any lookup", async () => {
    authedUser = { id: "u-2", app_metadata: {} };
    const { status } = await call({ mode: "link" });

    expect(status).toBe(403);
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });
});
