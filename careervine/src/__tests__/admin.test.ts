import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { isAdmin, writeAudit } from '@/lib/admin';

describe('isAdmin', () => {
  it('is true when app_metadata.role === "admin"', () => {
    expect(isAdmin({ app_metadata: { role: 'admin' } } as unknown as User)).toBe(true);
  });

  it('is false for a different role, missing role, or null user', () => {
    expect(isAdmin({ app_metadata: { role: 'editor' } } as unknown as User)).toBe(false);
    expect(isAdmin({ app_metadata: {} } as unknown as User)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('ignores a role claim placed in user_metadata (only app_metadata counts)', () => {
    expect(
      isAdmin({ user_metadata: { role: 'admin' }, app_metadata: {} } as unknown as User),
    ).toBe(false);
  });
});

describe('writeAudit', () => {
  function mockService(insertResult: { error: { message: string } | null }) {
    const insert = vi.fn().mockResolvedValue(insertResult);
    const from = vi.fn().mockReturnValue({ insert });
    return { service: { from } as unknown as SupabaseClient, from, insert };
  }

  beforeEach(() => vi.clearAllMocks());

  it('inserts a normalized audit row with defaults applied', async () => {
    const { service, from, insert } = mockService({ error: null });

    await writeAudit(service, {
      adminId: 'admin-1',
      targetUserId: 'user-9',
      action: 'suspend',
    });

    expect(from).toHaveBeenCalledWith('admin_audit_log');
    expect(insert).toHaveBeenCalledWith({
      admin_id: 'admin-1',
      target_user_id: 'user-9',
      action: 'suspend',
      detail: {},
      outcome: 'ok',
    });
  });

  it('passes through detail and outcome, and null target', async () => {
    const { service, insert } = mockService({ error: null });

    await writeAudit(service, {
      adminId: 'admin-1',
      action: 'grant_bundle',
      detail: { bundleId: 3, allowed: true },
      outcome: 'error',
    });

    expect(insert).toHaveBeenCalledWith({
      admin_id: 'admin-1',
      target_user_id: null,
      action: 'grant_bundle',
      detail: { bundleId: 3, allowed: true },
      outcome: 'error',
    });
  });

  it('never throws on insert failure (best-effort) but logs loudly', async () => {
    const { service } = mockService({ error: { message: 'boom' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      writeAudit(service, { adminId: 'admin-1', action: 'suspend' }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
