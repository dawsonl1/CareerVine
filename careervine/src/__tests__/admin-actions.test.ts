import { describe, it, expect } from "vitest";
import { checkRoleChange } from "@/lib/admin-actions";

const base = {
  actingAdminId: "admin-1",
  targetUserId: "user-2",
};

describe("checkRoleChange", () => {
  it("allows granting admin to a non-admin", () => {
    expect(
      checkRoleChange({ ...base, nextRole: "admin", targetIsAdmin: false, adminCount: 1 }),
    ).toEqual({ ok: true });
  });

  it("rejects granting admin to someone who already is one", () => {
    const res = checkRoleChange({
      ...base,
      nextRole: "admin",
      targetIsAdmin: true,
      adminCount: 2,
    });
    expect(res.ok).toBe(false);
  });

  it("allows revoking another admin when more than one admin exists", () => {
    expect(
      checkRoleChange({ ...base, nextRole: null, targetIsAdmin: true, adminCount: 2 }),
    ).toEqual({ ok: true });
  });

  it("rejects self-revoke (self-lockout guard)", () => {
    const res = checkRoleChange({
      actingAdminId: "admin-1",
      targetUserId: "admin-1",
      nextRole: null,
      targetIsAdmin: true,
      adminCount: 3,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/your own/i);
  });

  it("rejects revoking the last remaining admin (system-lockout guard)", () => {
    const res = checkRoleChange({
      ...base,
      nextRole: null,
      targetIsAdmin: true,
      adminCount: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/last/i);
  });

  it("rejects revoking a non-admin", () => {
    const res = checkRoleChange({
      ...base,
      nextRole: null,
      targetIsAdmin: false,
      adminCount: 2,
    });
    expect(res.ok).toBe(false);
  });
});
