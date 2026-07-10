import { describe, it, expect } from "vitest";
import { userPhotoKey, bundlePhotoKey, sha256Hex } from "@/lib/r2";

describe("R2 photo keys", () => {
  const bytes = new TextEncoder().encode("fake-webp-bytes");

  it("user keys are per-user, per-contact, content-versioned", () => {
    const key = userPhotoKey("user-1", 42, bytes);
    expect(key).toBe(`careervine/contact-photos/user-1/42-${sha256Hex(bytes).slice(0, 8)}.webp`);
  });

  it("bundle keys are pure content hashes — identical images dedupe", () => {
    const a = bundlePhotoKey(bytes);
    const b = bundlePhotoKey(new TextEncoder().encode("fake-webp-bytes"));
    expect(a).toBe(b);
    expect(a).toBe(`careervine/bundle-photos/${sha256Hex(bytes).slice(0, 16)}.webp`);
  });

  it("different content produces different keys (cache-bust via key, not query string)", () => {
    expect(bundlePhotoKey(bytes)).not.toBe(bundlePhotoKey(new TextEncoder().encode("other")));
    expect(userPhotoKey("user-1", 42, bytes)).not.toBe(
      userPhotoKey("user-1", 42, new TextEncoder().encode("other")),
    );
  });
});
