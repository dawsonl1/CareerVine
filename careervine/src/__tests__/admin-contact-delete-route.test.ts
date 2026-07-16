import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DELETE /api/admin/users/[id]/contacts/[contactId] (CAR-135 / R4.4): deleting
 * a contact must also clear its photo from storage, since the object doesn't
 * cascade with the DB row.
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

vi.mock("@/lib/admin", () => ({
  writeAudit: vi.fn(),
}));

const { cleanupContactPhoto } = vi.hoisted(() => ({ cleanupContactPhoto: vi.fn(async () => {}) }));
vi.mock("@/lib/contact-photo-cleanup", () => ({
  cleanupContactPhoto,
}));

import { DELETE } from "@/app/api/admin/users/[id]/contacts/[contactId]/route";

const CONTACT = {
  id: 7,
  name: "Ada Lovelace",
  user_id: "u-1",
  photo_url: "https://assets.careervine.app/careervine/contact-photos/u-1/7-abc12345.webp",
};

function makeReadChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

function makeDeleteChain(result: { error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.delete = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeRequest() {
  return {
    method: "DELETE",
    nextUrl: new URL("http://localhost:3000/api/admin/users/u-1/contacts/7"),
    headers: new Headers(),
  } as unknown as Request;
}

async function call(params: Record<string, string> = { id: "u-1", contactId: "7" }) {
  const response = await DELETE(makeRequest() as never, { params: Promise.resolve(params) } as never);
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  authedUser = { id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } };
});

describe("DELETE /api/admin/users/[id]/contacts/[contactId]", () => {
  it("deletes the contact and cleans up its photo", async () => {
    mockFrom
      .mockReturnValueOnce(makeReadChain({ data: CONTACT, error: null }))
      .mockReturnValueOnce(makeDeleteChain({ error: null }));

    const { status, data } = await call();

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(cleanupContactPhoto).toHaveBeenCalledWith(mockServiceClient, "u-1", 7, CONTACT.photo_url);
  });

  it("returns 404 and skips cleanup when the contact isn't on the account", async () => {
    mockFrom.mockReturnValueOnce(makeReadChain({ data: null, error: null }));

    const { status } = await call();

    expect(status).toBe(404);
    expect(cleanupContactPhoto).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    authedUser = { id: "user-9", app_metadata: {} };
    const { status } = await call();
    expect(status).toBe(403);
    expect(cleanupContactPhoto).not.toHaveBeenCalled();
  });
});
