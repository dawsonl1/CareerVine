import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

vi.mock("@/mcp/auth-config", () => ({
  getSupabaseAuthIssuer: () => "https://test.supabase.co/auth/v1",
  getSupabaseJwksUrl: () => "https://test.supabase.co/auth/v1/.well-known/jwks.json",
}));

import { verifyMcpToken, setJwksForTests } from "../verify-token";

const ISSUER = "https://test.supabase.co/auth/v1";

describe("verifyMcpToken", () => {
  let privateKey: CryptoKey;

  beforeEach(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";
    publicJwk.kid = "test";
    setJwksForTests(createLocalJWKSet({ keys: [publicJwk] }));
  });

  async function sign(payload: Record<string, unknown>, expiresIn = "1h") {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(ISSUER)
      .setExpirationTime(expiresIn)
      .setSubject("user-123")
      .sign(privateKey);
  }

  it("accepts a valid authenticated token", async () => {
    const token = await sign({ role: "authenticated", client_id: "claude" });
    const info = await verifyMcpToken(new Request("http://localhost"), token);
    expect(info?.extra?.userId).toBe("user-123");
    expect(info?.clientId).toBe("claude");
  });

  it("rejects anon role", async () => {
    const token = await sign({ role: "anon" });
    expect(await verifyMcpToken(new Request("http://localhost"), token)).toBeUndefined();
  });

  it("rejects wrong issuer", async () => {
    const token = new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer("https://evil.example/auth/v1")
      .setExpirationTime("1h")
      .setSubject("user-123")
      .sign(privateKey);
    expect(await verifyMcpToken(new Request("http://localhost"), await token)).toBeUndefined();
  });

  it("rejects expired token", async () => {
    const token = await sign({ role: "authenticated" }, "-1h");
    expect(await verifyMcpToken(new Request("http://localhost"), token)).toBeUndefined();
  });

  it("rejects missing bearer token", async () => {
    expect(await verifyMcpToken(new Request("http://localhost"))).toBeUndefined();
  });
});
