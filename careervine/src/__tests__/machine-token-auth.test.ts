/**
 * CAR-140 (F25 / F55 part 1): the BUNDLE_ADMIN_TOKEN machine routes
 * (admin/ai-access, admin/bundles/publish) must, on top of the constant-time
 * bearer check, (a) write an admin_audit_log row under the machine actor and
 * (b) 429 under burst. The shared mechanism lives in src/lib/admin-auth.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Rate limiter is mocked so we can force allow/deny deterministically (the real
// checkRateLimit degrades to allow-all without Upstash env).
const checkRateLimit = vi.fn(
  async (): Promise<{ allowed: boolean; remaining: number; resetAt: number | null }> => ({
    allowed: true,
    remaining: 99,
    resetAt: null,
  }),
);
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...(args as [])),
}));

// ai-access touches an in-process entitlement cache — stub it out.
vi.mock("@/lib/openai", () => ({ evictSharedAccessCache: vi.fn() }));

// bundles/publish: keep BundlePublishError + the Zod schemas real; stub only the
// DB-driving functions so a `begin` POST reaches the audit write without a DB.
vi.mock("@/lib/bundle-publish", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/bundle-publish")>();
  return {
    ...actual,
    beginPublish: vi.fn(async () => ({ bundleId: 1, stagingVersion: 3 })),
  };
});

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(),
}));

import { NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  isAuthorizedAdminToken,
  writeMachineTokenAudit,
  checkMachineRateLimit,
  MACHINE_ADMIN_ACTOR,
  MACHINE_ADMIN_AUDIT_ID,
} from "@/lib/admin-auth";
import { POST as aiAccessPOST } from "@/app/api/admin/ai-access/route";
import { POST as publishPOST } from "@/app/api/admin/bundles/publish/route";

const TOKEN = "machine-secret";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** Records inserts/upserts per table; every write resolves cleanly. */
function makeService() {
  const inserts: Record<string, unknown[]> = {};
  const upserts: Record<string, unknown[]> = {};
  const client = {
    from: (table: string) => ({
      insert: (payload: unknown) => {
        (inserts[table] ??= []).push(payload);
        return Promise.resolve({ error: null });
      },
      upsert: (payload: unknown) => {
        (upserts[table] ??= []).push(payload);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { client, inserts, upserts };
}

function aiAccessReq(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/admin/ai-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function publishReq(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/admin/bundles/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 99, resetAt: null });
  vi.stubEnv("BUNDLE_ADMIN_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── admin-auth helpers (the shared mechanism) ─────────────────────────────

describe("admin-auth helpers", () => {
  it("isAuthorizedAdminToken accepts the correct bearer and rejects the rest", () => {
    expect(isAuthorizedAdminToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorizedAdminToken("Bearer wrong", TOKEN)).toBe(false);
    expect(isAuthorizedAdminToken(TOKEN, TOKEN)).toBe(false); // no Bearer prefix
    expect(isAuthorizedAdminToken(null, TOKEN)).toBe(false);
    expect(isAuthorizedAdminToken(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });

  it("writeMachineTokenAudit logs under the nil-UUID sentinel with the actor label", async () => {
    const { client, inserts } = makeService();
    await writeMachineTokenAudit(client as never, {
      action: "grant_ai_access",
      targetUserId: USER_ID,
      detail: { sharedAccess: true },
    });
    const rows = inserts["admin_audit_log"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].admin_id).toBe(MACHINE_ADMIN_AUDIT_ID);
    expect(rows[0].target_user_id).toBe(USER_ID);
    expect(rows[0].action).toBe("grant_ai_access");
    expect(rows[0].detail).toMatchObject({ actor: MACHINE_ADMIN_ACTOR, sharedAccess: true });
  });

  it("checkMachineRateLimit reflects the underlying limiter and namespaces by bucket", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 1 });
    expect(await checkMachineRateLimit("admin-ai-access", 30)).toBe(false);
    expect(checkRateLimit).toHaveBeenCalledWith(
      MACHINE_ADMIN_ACTOR,
      expect.objectContaining({ bucket: "admin-ai-access", limit: 30 }),
    );
  });
});

// ── ai-access route ───────────────────────────────────────────────────────

describe("POST /api/admin/ai-access", () => {
  it("401s an unauthorized request without touching the limiter", async () => {
    const res = await aiAccessPOST(aiAccessReq({ userId: USER_ID, sharedAccess: true }, false));
    expect(res.status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("429s under burst and does not mutate", async () => {
    const { client, inserts, upserts } = makeService();
    vi.mocked(createSupabaseServiceClient).mockReturnValue(client as never);
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1 });

    const res = await aiAccessPOST(aiAccessReq({ userId: USER_ID, sharedAccess: true }));
    expect(res.status).toBe(429);
    expect(upserts["user_ai_access"]).toBeUndefined();
    expect(inserts["admin_audit_log"]).toBeUndefined();
  });

  it("grants access and writes an audit row on success", async () => {
    const { client, inserts, upserts } = makeService();
    vi.mocked(createSupabaseServiceClient).mockReturnValue(client as never);

    const res = await aiAccessPOST(aiAccessReq({ userId: USER_ID, sharedAccess: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: USER_ID, sharedAccess: true });

    expect(upserts["user_ai_access"]).toHaveLength(1);
    const audit = inserts["admin_audit_log"] as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0].admin_id).toBe(MACHINE_ADMIN_AUDIT_ID);
    expect(audit[0].action).toBe("grant_ai_access");
    expect(audit[0].target_user_id).toBe(USER_ID);
    expect(audit[0].detail).toMatchObject({ actor: MACHINE_ADMIN_ACTOR, sharedAccess: true });
  });

  it("records a revoke action when sharedAccess is false", async () => {
    const { client, inserts } = makeService();
    vi.mocked(createSupabaseServiceClient).mockReturnValue(client as never);

    const res = await aiAccessPOST(aiAccessReq({ userId: USER_ID, sharedAccess: false }));
    expect(res.status).toBe(200);
    const audit = inserts["admin_audit_log"] as Array<Record<string, unknown>>;
    expect(audit[0].action).toBe("revoke_ai_access");
  });
});

// ── bundles/publish route ─────────────────────────────────────────────────

describe("POST /api/admin/bundles/publish", () => {
  it("401s an unauthorized request", async () => {
    const res = await publishPOST(publishReq({ mode: "begin", slug: "pm-2026" }, false));
    expect(res.status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("429s under burst", async () => {
    const { client, inserts } = makeService();
    vi.mocked(createSupabaseServiceClient).mockReturnValue(client as never);
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1 });

    const res = await publishPOST(publishReq({ mode: "begin", slug: "pm-2026" }));
    expect(res.status).toBe(429);
    expect(inserts["admin_audit_log"]).toBeUndefined();
  });

  it("audits the begin lifecycle mode", async () => {
    const { client, inserts } = makeService();
    vi.mocked(createSupabaseServiceClient).mockReturnValue(client as never);

    const res = await publishPOST(publishReq({ mode: "begin", slug: "pm-2026" }));
    expect(res.status).toBe(200);
    const audit = inserts["admin_audit_log"] as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0].admin_id).toBe(MACHINE_ADMIN_AUDIT_ID);
    expect(audit[0].action).toBe("bundle_publish_begin");
    expect(audit[0].detail).toMatchObject({ actor: MACHINE_ADMIN_ACTOR, slug: "pm-2026" });
  });
});
