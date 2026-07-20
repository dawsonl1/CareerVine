import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptOAuthToken, decryptOAuthToken, refreshTokenIfNeeded } from "@/lib/oauth-helpers";

describe("OAuth token encryption (CAR-27)", () => {
  beforeEach(() => {
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  it("round-trips a token through encrypt/decrypt", () => {
    const stored = encryptOAuthToken("ya29.a0AfB_secret-access-token");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("secret-access-token");
    expect(decryptOAuthToken(stored)).toBe("ya29.a0AfB_secret-access-token");
  });

  it("passes legacy plaintext tokens through unchanged", () => {
    // Pre-backfill rows are raw Google tokens (never "v1."-prefixed)
    expect(decryptOAuthToken("ya29.legacy-plaintext")).toBe("ya29.legacy-plaintext");
    expect(decryptOAuthToken("1//refresh-token")).toBe("1//refresh-token");
  });

  it("produces distinct ciphertexts for the same token (fresh IV per call)", () => {
    expect(encryptOAuthToken("same")).not.toBe(encryptOAuthToken("same"));
  });

  it("token refresh writes the new access token encrypted", async () => {
    let updatePayload: Record<string, string> | undefined;
    const fakeSupabase = {
      from: vi.fn(() => ({
        update: (payload: Record<string, string>) => {
          updatePayload = payload;
          return { eq: vi.fn().mockResolvedValue({ error: null }) };
        },
        delete: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      })),
    };
    const fakeOAuth2Client = {
      refreshAccessToken: vi.fn().mockResolvedValue({
        credentials: { access_token: "fresh-access-token", expiry_date: Date.now() + 3600_000 },
      }),
      setCredentials: vi.fn(),
    };

    await refreshTokenIfNeeded(
      // CAR-158 typed this parameter as SupabaseClient<Database> (it was `any`).
      // The stub implements only the from().update().eq() path this test
      // exercises, so it is narrowed to the real parameter type here rather
      // than widening the production signature back out to accommodate a mock.
      fakeSupabase as unknown as Parameters<typeof refreshTokenIfNeeded>[0],
      fakeOAuth2Client as never,
      "user-refresh-encrypt",
      Date.now() - 1000, // expired → forces refresh
      "Gmail",
    );

    expect(updatePayload).toBeDefined();
    expect(updatePayload!.access_token.startsWith("v1.")).toBe(true);
    expect(decryptOAuthToken(updatePayload!.access_token)).toBe("fresh-access-token");
  });
});
