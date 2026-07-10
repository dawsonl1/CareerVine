import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const verifyOtpMock = vi.fn();
vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: { verifyOtp: (...args: unknown[]) => verifyOtpMock(...args) },
  }),
}));

const trackServerMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/analytics/server", () => ({
  trackServer: (...args: unknown[]) => trackServerMock(...args),
}));

import { GET } from "@/app/auth/confirm/route";

const confirmUrl = (params: Record<string, string>) =>
  new NextRequest(
    `http://localhost:3000/auth/confirm?${new URLSearchParams(params)}`,
  );

const location = (res: Response) => new URL(res.headers.get("location")!);

beforeEach(() => {
  verifyOtpMock.mockReset();
  trackServerMock.mockClear();
});

describe("GET /auth/confirm", () => {
  it("verifies a signup token, tracks the funnel event, and redirects to the dashboard", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: { id: "user-1" }, session: {} },
      error: null,
    });

    const res = await GET(confirmUrl({ token_hash: "abc123", type: "signup" }));

    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "signup", token_hash: "abc123" });
    expect(location(res).pathname).toBe("/");
    expect(trackServerMock).toHaveBeenCalledWith("user-1", "user_email_verified", {});
  });

  it("honors a relative next param (recovery → /reset-password) without tracking signup verification", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: { id: "user-1" }, session: {} },
      error: null,
    });

    const res = await GET(
      confirmUrl({ token_hash: "abc123", type: "recovery", next: "/reset-password" }),
    );

    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "recovery", token_hash: "abc123" });
    expect(location(res).pathname).toBe("/reset-password");
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it.each(["https://evil.com/phish", "//evil.com", "/ok\\..\\bad", "relative-no-slash"])(
    "rejects open-redirect next value %s and falls back to /",
    async (next) => {
      verifyOtpMock.mockResolvedValue({
        data: { user: { id: "user-1" }, session: {} },
        error: null,
      });

      const res = await GET(confirmUrl({ token_hash: "abc123", type: "signup", next }));

      const url = location(res);
      expect(url.origin).toBe("http://localhost:3000");
      expect(url.pathname).toBe("/");
    },
  );

  it("redirects to sign-in with context when the token is expired or already used", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Token has expired or is invalid" },
    });

    const res = await GET(confirmUrl({ token_hash: "stale", type: "signup" }));

    const url = location(res);
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.get("error")).toBe("confirm-expired");
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it.each([
    { type: "signup" }, // missing token_hash
    { token_hash: "abc123" }, // missing type
    { token_hash: "abc123", type: "sms" }, // non-email OTP type
  ])("rejects malformed links (%o) without calling Supabase", async (params) => {
    const res = await GET(confirmUrl(params as Record<string, string>));

    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(location(res).searchParams.get("error")).toBe("confirm-expired");
  });
});
