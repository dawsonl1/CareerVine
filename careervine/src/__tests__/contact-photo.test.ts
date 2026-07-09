import { describe, expect, it } from "vitest";
import {
  MAX_CONTACT_PHOTO_BYTES,
  validateContactPhotoFile,
} from "@/lib/contact-photo";

describe("validateContactPhotoFile", () => {
  it("accepts a supported image under size limit", () => {
    const file = new File(["abc"], "avatar.png", { type: "image/png" });
    expect(validateContactPhotoFile(file)).toBeNull();
  });

  it("rejects unsupported file types", () => {
    const file = new File(["abc"], "avatar.svg", { type: "image/svg+xml" });
    expect(validateContactPhotoFile(file)).toBe("Please upload a JPG, PNG, WebP, or GIF image.");
  });

  it("rejects images over max size", () => {
    const oversized = new Uint8Array(MAX_CONTACT_PHOTO_BYTES + 1);
    const file = new File([oversized], "avatar.jpg", { type: "image/jpeg" });
    expect(validateContactPhotoFile(file)).toBe("Photo must be 5MB or smaller.");
  });
});
