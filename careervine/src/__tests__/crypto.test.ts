import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, CryptoError } from "@/lib/crypto";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("crypto", () => {
  beforeEach(() => {
    process.env.BYOK_ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    delete process.env.BYOK_ENCRYPTION_KEY;
  });

  it("round-trips plaintext", () => {
    const plaintext = "sk-proj-test-key-abcdefghijklmnop";
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces unique ciphertext for the same plaintext", () => {
    const plaintext = "sk-proj-same-key";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("uses v1. format", () => {
    const encrypted = encryptSecret("sk-test-key-1234567890");
    expect(encrypted.startsWith("v1.")).toBe(true);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptSecret("sk-test-key-1234567890");
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow(CryptoError);
  });

  it("throws when BYOK_ENCRYPTION_KEY is missing", () => {
    delete process.env.BYOK_ENCRYPTION_KEY;
    expect(() => encryptSecret("sk-test")).toThrow(CryptoError);
    expect(() => decryptSecret("v1.a.b.c")).toThrow(CryptoError);
  });

  it("throws when BYOK_ENCRYPTION_KEY is wrong length", () => {
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptSecret("sk-test")).toThrow(CryptoError);
  });
});
