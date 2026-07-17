// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/components/auth-provider";

/**
 * CAR-141 (R1.3): suspended accounts are "banned" in GoTrue. signIn must
 * translate that opaque error into the suspended-account message while
 * passing every other error through untouched.
 */

const signInWithPasswordMock = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPasswordMock(...args),
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  }),
}));

vi.mock("@/lib/analytics/client", () => ({
  track: vi.fn(),
  identifyNewUser: vi.fn(),
}));

beforeEach(() => {
  signInWithPasswordMock.mockReset();
});

afterEach(cleanup);

function renderProviderSignIn() {
  let signIn!: ReturnType<typeof useAuth>["signIn"];
  function Probe() {
    signIn = useAuth().signIn;
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  return (email: string, password: string) => signIn(email, password);
}

describe("AuthProvider.signIn — banned-account translation", () => {
  it("translates GoTrue's banned error into the suspended-account message", async () => {
    signInWithPasswordMock.mockResolvedValue({
      error: { message: "User is banned" },
    });
    const signIn = renderProviderSignIn();

    let result: Awaited<ReturnType<typeof signIn>>;
    await act(async () => {
      result = await signIn("suspended@example.com", "password123");
    });

    expect(result!.error).toMatch(/suspended/i);
    expect(result!.error).not.toMatch(/banned/i);
  });

  it("passes other sign-in errors through untouched", async () => {
    signInWithPasswordMock.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const signIn = renderProviderSignIn();

    let result: Awaited<ReturnType<typeof signIn>>;
    await act(async () => {
      result = await signIn("someone@example.com", "wrongpass1");
    });

    expect(result!.error).toBe("Invalid login credentials");
  });

  it("returns an empty object on success", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    const signIn = renderProviderSignIn();

    let result: Awaited<ReturnType<typeof signIn>>;
    await act(async () => {
      result = await signIn("someone@example.com", "correct-horse-1");
    });

    expect(result!).toEqual({});
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: "someone@example.com",
      password: "correct-horse-1",
    });
  });
});
