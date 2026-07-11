import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/lib/public-routes";

describe("isPublicPath (CAR-64)", () => {
  it("allows the signed-out surfaces", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/privacy")).toBe(true);
    expect(isPublicPath("/reset-password")).toBe(true);
    expect(isPublicPath("/contacts/preview")).toBe(true);
    expect(isPublicPath("/auth")).toBe(true);
    expect(isPublicPath("/auth/confirm")).toBe(true);
    expect(isPublicPath("/oauth/consent")).toBe(true);
  });

  it("treats app pages as protected", () => {
    for (const path of [
      "/contacts",
      "/contacts/abc-123",
      "/companies",
      "/companies/xyz",
      "/meetings",
      "/action-items",
      "/inbox",
      "/interactions",
      "/outreach",
      "/calendar",
      "/settings",
      "/admin",
      "/admin/users",
      "/onboarding/connected",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("matches prefixes on segment boundaries only", () => {
    expect(isPublicPath("/authors")).toBe(false);
    expect(isPublicPath("/oauthful")).toBe(false);
    expect(isPublicPath("/privacy-policy")).toBe(false);
  });
});
