import { describe, it, expect } from "vitest";
import { userPhotoKey, bundlePhotoKey, sha256Hex } from "@/lib/r2";
import { userPhotoKeyFromAnyUrl } from "@/lib/photo-urls";

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

// Host-agnostic live-set extraction for the R2 sweep (CAR-156 deep-review
// fix). Must accept our key under ANY host — old domains stay live through a
// migration — and reject everything that isn't a user-photo path.
describe("userPhotoKeyFromAnyUrl", () => {
  const key = "careervine/contact-photos/u1/7-abcd1234.webp";

  it("extracts the key regardless of host or scheme", () => {
    expect(userPhotoKeyFromAnyUrl(`https://assets.careervine.app/${key}`)).toBe(key);
    expect(userPhotoKeyFromAnyUrl(`https://old-cdn.example.com/${key}`)).toBe(key);
    expect(userPhotoKeyFromAnyUrl(`http://pub-123.r2.dev/${key}`)).toBe(key);
  });

  it("rejects non-user-photo paths, malformed URLs, and empties", () => {
    expect(userPhotoKeyFromAnyUrl("https://assets.careervine.app/careervine/bundle-photos/ff00.webp")).toBeNull();
    expect(userPhotoKeyFromAnyUrl("https://media.licdn.com/dms/image/abc.jpg")).toBeNull();
    expect(userPhotoKeyFromAnyUrl("not-a-url")).toBeNull();
    expect(userPhotoKeyFromAnyUrl(null)).toBeNull();
    expect(userPhotoKeyFromAnyUrl("")).toBeNull();
  });
});
