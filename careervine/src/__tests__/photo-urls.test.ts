import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  r2PublicUrl,
  r2KeyFromPublicUrl,
  isBundlePhotoUrl,
  isUserPhotoUrl,
  bundlePhotoOverwriteAllowed,
} from "@/lib/photo-urls";

const BASE = "https://assets.careervine.app";
const BUNDLE_URL = `${BASE}/careervine/bundle-photos/abcdef0123456789.webp`;
const OTHER_BUNDLE_URL = `${BASE}/careervine/bundle-photos/ffffff0123456789.webp`;
const USER_URL = `${BASE}/careervine/contact-photos/user-1/42-deadbeef.webp`;
const LICDN_URL = "https://media.licdn.com/dms/image/abc.jpg";
const LEGACY_SUPABASE_URL =
  "https://xyz.supabase.co/storage/v1/object/public/contact-photos/user-1/42.jpg?t=123";

beforeEach(() => {
  vi.stubEnv("R2_PUBLIC_BASE_URL", BASE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("r2KeyFromPublicUrl", () => {
  it("round-trips keys through r2PublicUrl", () => {
    const key = "careervine/contact-photos/user-1/42-deadbeef.webp";
    expect(r2KeyFromPublicUrl(r2PublicUrl(key))).toBe(key);
  });

  it("rejects URLs on other hosts and non-photo keys", () => {
    expect(r2KeyFromPublicUrl(LICDN_URL)).toBeNull();
    expect(r2KeyFromPublicUrl(LEGACY_SUPABASE_URL)).toBeNull();
    expect(r2KeyFromPublicUrl(`${BASE}/personal-website/hero.jpg`)).toBeNull();
    expect(r2KeyFromPublicUrl(null)).toBeNull();
  });

  it("tolerates a trailing slash on the configured base URL", () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", `${BASE}/`);
    expect(isBundlePhotoUrl(BUNDLE_URL)).toBe(true);
  });
});

describe("isBundlePhotoUrl / isUserPhotoUrl", () => {
  it("distinguishes the two prefixes", () => {
    expect(isBundlePhotoUrl(BUNDLE_URL)).toBe(true);
    expect(isBundlePhotoUrl(USER_URL)).toBe(false);
    expect(isUserPhotoUrl(USER_URL)).toBe(true);
    expect(isUserPhotoUrl(BUNDLE_URL)).toBe(false);
  });

  it("treats external and missing URLs as neither", () => {
    for (const url of [LICDN_URL, LEGACY_SUPABASE_URL, null, undefined, ""]) {
      expect(isBundlePhotoUrl(url)).toBe(false);
      expect(isUserPhotoUrl(url)).toBe(false);
    }
  });

  it("fails closed when R2_PUBLIC_BASE_URL is unset", () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "");
    expect(isBundlePhotoUrl(BUNDLE_URL)).toBe(false);
    expect(isUserPhotoUrl(USER_URL)).toBe(false);
  });
});

describe("bundlePhotoOverwriteAllowed — subscriber photo policy", () => {
  it("fills an empty photo", () => {
    expect(bundlePhotoOverwriteAllowed(null, BUNDLE_URL)).toBe(true);
  });

  it("refreshes a stale bundle photo", () => {
    expect(bundlePhotoOverwriteAllowed(OTHER_BUNDLE_URL, BUNDLE_URL)).toBe(true);
  });

  it("is a no-op when the photo is already current", () => {
    expect(bundlePhotoOverwriteAllowed(BUNDLE_URL, BUNDLE_URL)).toBe(false);
  });

  it("never clobbers a user's own photo (manual upload or import mirror)", () => {
    expect(bundlePhotoOverwriteAllowed(USER_URL, BUNDLE_URL)).toBe(false);
    expect(bundlePhotoOverwriteAllowed(LEGACY_SUPABASE_URL, BUNDLE_URL)).toBe(false);
  });

  it("never writes a non-bundle incoming URL", () => {
    expect(bundlePhotoOverwriteAllowed(null, LICDN_URL)).toBe(false);
    expect(bundlePhotoOverwriteAllowed(null, USER_URL)).toBe(false);
    expect(bundlePhotoOverwriteAllowed(null, null)).toBe(false);
  });
});
