// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import AuthForm from "@/components/auth-form";

const signUpMock = vi.fn();
const trackMock = vi.fn();
const identifyNewUserMock = vi.fn();

vi.mock("@/lib/analytics/client", () => ({
  track: (...args: unknown[]) => trackMock(...args),
  identifyNewUser: (...args: unknown[]) => identifyNewUserMock(...args),
}));

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signUp: (...args: unknown[]) => signUpMock(...args),
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
  }),
}));

beforeEach(() => {
  signUpMock.mockReset();
  trackMock.mockReset();
  identifyNewUserMock.mockReset();
});

afterEach(cleanup);

/** Grabs the signUp method from context so provider logic can be tested directly. */
function renderProviderSignUp() {
  let signUp!: ReturnType<typeof useAuth>["signUp"];
  function Probe() {
    signUp = useAuth().signUp;
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  return (email: string) => signUp(email, "password123", "Test", "User");
}

describe("AuthProvider.signUp — duplicate email detection", () => {
  it("returns existingAccount when Supabase obfuscates a duplicate signup (user with empty identities)", async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: "fake", identities: [] }, session: null },
      error: null,
    });
    const signUp = renderProviderSignUp();

    let result: Awaited<ReturnType<typeof signUp>>;
    await act(async () => {
      result = await signUp("taken@example.com");
    });

    expect(result!.existingAccount).toBe(true);
    expect(result!.error).toMatch(/already exists/i);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("returns success and tracks for a genuinely new user (identities populated)", async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: { id: "new", identities: [{ id: "ident-1" }] },
        session: null,
      },
      error: null,
    });
    const signUp = renderProviderSignUp();

    let result: Awaited<ReturnType<typeof signUp>>;
    await act(async () => {
      result = await signUp("new@example.com");
    });

    expect(result!.error).toBeUndefined();
    expect(result!.existingAccount).toBeUndefined();
    // Identity must bind to the real (still-unconfirmed) user id BEFORE the
    // signup event fires, so the event can't land on an anonymous person that
    // later merges into the wrong account (CAR-58).
    expect(identifyNewUserMock).toHaveBeenCalledWith("new", "new@example.com");
    expect(identifyNewUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      trackMock.mock.invocationCallOrder[0],
    );
    expect(trackMock).toHaveBeenCalledWith("user_signed_up");
  });

  it("passes through Supabase errors untouched", async () => {
    signUpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Password should be at least 8 characters" },
    });
    const signUp = renderProviderSignUp();

    let result: Awaited<ReturnType<typeof signUp>>;
    await act(async () => {
      result = await signUp("new@example.com");
    });

    expect(result!.error).toBe("Password should be at least 8 characters");
    expect(result!.existingAccount).toBeUndefined();
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe("AuthForm — signup with an already-registered email", () => {
  function fillAndSubmitSignup() {
    fireEvent.change(screen.getByPlaceholderText("First name"), { target: { value: "Test" } });
    fireEvent.change(screen.getByPlaceholderText("Last name"), { target: { value: "User" } });
    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "taken@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  }

  it("shows the account-exists notice instead of the check-email screen, with sign-in and reset paths", async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: "fake", identities: [] }, session: null },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthForm initialMode="signup" />
      </AuthProvider>
    );
    fillAndSubmitSignup();

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeTruthy();
    });
    // Must NOT pretend an email was sent
    expect(screen.queryByText(/we sent a confirmation link/i)).toBeNull();

    // "Sign in" inside the notice switches mode with the email preserved
    // (the page footer has its own "Sign in" toggle, so scope to the notice)
    const notice = screen.getByText(/already exists/i).closest("div")!;
    fireEvent.click(within(notice).getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Welcome back")).toBeTruthy();
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe("taken@example.com");
    // Notice is cleared after switching modes
    expect(screen.queryByText(/already exists/i)).toBeNull();
  });

  it("offers a reset-password path from the notice", async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: "fake", identities: [] }, session: null },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthForm initialMode="signup" />
      </AuthProvider>
    );
    fillAndSubmitSignup();

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset it" }));
    expect(screen.getByText("Reset password")).toBeTruthy();
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe("taken@example.com");
  });

  it("still shows the check-email screen for a genuinely new signup", async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: { id: "new", identities: [{ id: "ident-1" }] },
        session: null,
      },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthForm initialMode="signup" />
      </AuthProvider>
    );
    fillAndSubmitSignup();

    await waitFor(() => {
      expect(screen.getByText("Check your email")).toBeTruthy();
    });
    expect(screen.queryByText(/already exists/i)).toBeNull();
  });
});
