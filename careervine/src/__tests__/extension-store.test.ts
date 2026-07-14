import { describe, it, expect, afterEach, vi } from "vitest";

describe("EXTENSION_STORE_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses NEXT_PUBLIC_EXTENSION_STORE_URL when set", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_EXTENSION_STORE_URL",
      "https://chromewebstore.google.com/detail/custom/abc",
    );
    const { EXTENSION_STORE_URL } = await import("@/lib/extension-store");
    expect(EXTENSION_STORE_URL).toBe(
      "https://chromewebstore.google.com/detail/custom/abc",
    );
  });

  it("falls back to the live Chrome Web Store listing", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "");
    const { EXTENSION_STORE_URL } = await import("@/lib/extension-store");
    expect(EXTENSION_STORE_URL).toBe(
      "https://chromewebstore.google.com/detail/careervine-linkedin-integ/jdiefmjeiihacjencfdempbgapnppooj",
    );
  });
});
