import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * cleanupContactPhoto (CAR-135 / R4.4): one contact's own photo must be removed
 * from R2 or legacy Supabase storage on delete/replace, but a shared bundle
 * photo (used across subscribers) must never be touched.
 */

const { deletePhotoByUrl } = vi.hoisted(() => ({ deletePhotoByUrl: vi.fn(async () => {}) }));

vi.mock("@/lib/r2", async () => {
  const actual = await vi.importActual<typeof import("@/lib/photo-urls")>("@/lib/photo-urls");
  return {
    isUserPhotoUrl: actual.isUserPhotoUrl,
    deletePhotoByUrl,
  };
});

import { cleanupContactPhoto, LEGACY_SUPABASE_PHOTO_MARKER } from "@/lib/contact-photo-cleanup";

const BASE = "https://assets.careervine.app";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.R2_PUBLIC_BASE_URL = BASE;
});

function mockSupabase() {
  const remove = vi.fn(async () => ({ data: null, error: null }));
  const supabase = {
    storage: { from: vi.fn(() => ({ remove })) },
  } as unknown as SupabaseClient;
  return { supabase, remove };
}

describe("cleanupContactPhoto", () => {
  it("deletes a per-user R2 photo we own", async () => {
    const { supabase, remove } = mockSupabase();
    const url = `${BASE}/careervine/contact-photos/user-1/7-abc12345.webp`;
    await cleanupContactPhoto(supabase, "user-1", 7, url);
    expect(deletePhotoByUrl).toHaveBeenCalledWith(url);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never deletes a shared bundle photo", async () => {
    const { supabase, remove } = mockSupabase();
    const url = `${BASE}/careervine/bundle-photos/deadbeefdeadbeef.webp`;
    await cleanupContactPhoto(supabase, "user-1", 7, url);
    expect(deletePhotoByUrl).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes a legacy Supabase photo by its conventional key", async () => {
    const { supabase, remove } = mockSupabase();
    const url = `https://proj.supabase.co${LEGACY_SUPABASE_PHOTO_MARKER}user-1/7.jpg`;
    await cleanupContactPhoto(supabase, "user-1", 7, url);
    expect(remove).toHaveBeenCalledWith(["user-1/7.jpg"]);
    expect(deletePhotoByUrl).not.toHaveBeenCalled();
  });

  it("no-ops on a null url", async () => {
    const { supabase, remove } = mockSupabase();
    await cleanupContactPhoto(supabase, "user-1", 7, null);
    expect(deletePhotoByUrl).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("swallows a legacy remove failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supabase = {
      storage: { from: vi.fn(() => ({ remove: vi.fn(async () => { throw new Error("boom"); }) })) },
    } as unknown as SupabaseClient;
    const url = `https://proj.supabase.co${LEGACY_SUPABASE_PHOTO_MARKER}user-1/7.jpg`;
    await expect(cleanupContactPhoto(supabase, "user-1", 7, url)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
