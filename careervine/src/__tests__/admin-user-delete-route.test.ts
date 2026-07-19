import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DELETE /api/admin/users/[id] (CAR-156 / R4.3): the Google OAuth grant must
 * be revoked BEFORE auth.admin.deleteUser — the cascade destroys the encrypted
 * token, after which the grant can never be revoked at Google. Revocation is
 * best-effort (a failure must not block the deletion the admin asked for),
 * and the storage/R2 cleanups still run after a successful delete.
 */

const order: string[] = [];

const getUserById = vi.fn(async () => ({
  data: { user: { id: "u-1", email: "target@example.com", app_metadata: {} } },
  error: null,
}));
const deleteUser = vi.fn(async () => {
  order.push("deleteUser");
  return { error: null };
});

const mockServiceClient = {
  auth: { admin: { getUserById, deleteUser } },
  from: vi.fn(),
};

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

vi.mock("@/lib/admin", () => ({
  writeAudit: vi.fn(),
}));

const { revokeAccess, removeUserStorageObjects, deleteUserPhotoObjects } = vi.hoisted(() => ({
  revokeAccess: vi.fn(async () => {}),
  removeUserStorageObjects: vi.fn(async () => {}),
  deleteUserPhotoObjects: vi.fn(async () => {}),
}));

vi.mock("@/lib/gmail", () => ({ revokeAccess }));
vi.mock("@/lib/storage-sweep", () => ({ removeUserStorageObjects }));
vi.mock("@/lib/r2", () => ({ deleteUserPhotoObjects }));

import { DELETE } from "@/app/api/admin/users/[id]/route";

function makeRequest() {
  return {
    method: "DELETE",
    nextUrl: new URL("http://localhost:3000/api/admin/users/u-1"),
    headers: new Headers(),
  } as unknown as Request;
}

async function call(id = "u-1") {
  const response = await DELETE(makeRequest() as never, { params: Promise.resolve({ id }) } as never);
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  authedUser = { id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } };
  revokeAccess.mockImplementation(async () => {
    order.push("revokeAccess");
  });
  removeUserStorageObjects.mockImplementation(async () => {
    order.push("removeUserStorageObjects");
  });
  deleteUserPhotoObjects.mockImplementation(async () => {
    order.push("deleteUserPhotoObjects");
  });
});

describe("DELETE /api/admin/users/[id]", () => {
  it("revokes the Google grant BEFORE deleting the auth user, then cleans storage", async () => {
    const { status, data } = await call();

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(revokeAccess).toHaveBeenCalledWith("u-1");
    expect(order).toEqual([
      "revokeAccess",
      "deleteUser",
      "removeUserStorageObjects",
      "deleteUserPhotoObjects",
    ]);
  });

  it("still deletes the account when revocation fails (best-effort)", async () => {
    revokeAccess.mockImplementation(async () => {
      throw new Error("google is down");
    });

    const { status } = await call();

    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledOnce();
  });

  it("does not run storage cleanup when deleteUser fails", async () => {
    deleteUser.mockImplementation(async () => {
      order.push("deleteUser");
      return { error: { message: "boom" } };
    });

    const { status } = await call();

    expect(status).toBe(400);
    expect(removeUserStorageObjects).not.toHaveBeenCalled();
    expect(deleteUserPhotoObjects).not.toHaveBeenCalled();
  });

  it("refuses to delete an admin account (and never revokes its grant)", async () => {
    getUserById.mockResolvedValueOnce({
      data: { user: { id: "u-1", email: "t@e.com", app_metadata: { role: "admin" } } },
      error: null,
    } as never);

    const { status } = await call();

    expect(status).toBe(400);
    expect(revokeAccess).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    authedUser = { id: "user-9", app_metadata: {} };
    const { status } = await call();
    expect(status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
