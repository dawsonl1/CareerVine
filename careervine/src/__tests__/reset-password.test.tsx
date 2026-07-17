// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import ResetPasswordPage from "@/app/reset-password/page";

/**
 * CAR-141 (R1.3/R1.5): /reset-password trusts /auth/confirm to have minted
 * the session server-side — one getSession() check gates the form, a missing
 * session is a dead link, and the submit path enforces the 8-character
 * minimum (R1.4) before calling updateUser.
 */

const getSessionMock = vi.fn();
const updateUserMock = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
      updateUser: (...args: unknown[]) => updateUserMock(...args),
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: "u-1" } } } });
  updateUserMock.mockResolvedValue({ error: null });
});

afterEach(cleanup);

async function renderWithSession() {
  render(<ResetPasswordPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Update password" })).toBeTruthy());
}

function fillAndSubmit(password: string, confirm: string) {
  fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByPlaceholderText("Re-enter new password"), {
    target: { value: confirm },
  });
  // fireEvent.submit bypasses native constraint validation so the component's
  // own checks are what's under test.
  fireEvent.submit(
    screen.getByRole("button", { name: "Update password" }).closest("form")!,
  );
}

describe("reset-password — session gating", () => {
  it("shows the verifying state until the session check resolves, then the form", async () => {
    let resolveSession!: (v: { data: { session: unknown } }) => void;
    getSessionMock.mockReturnValue(new Promise((r) => (resolveSession = r)));

    render(<ResetPasswordPage />);
    expect(screen.getByText("Verifying reset link...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update password" })).toBeNull();

    resolveSession({ data: { session: { user: { id: "u-1" } } } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update password" })).toBeTruthy(),
    );
  });

  it("shows the invalid-link error when there is no session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    render(<ResetPasswordPage />);
    await waitFor(() => expect(screen.getByText("Invalid or expired link")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Update password" })).toBeNull();
  });
});

describe("reset-password — validation", () => {
  it("rejects passwords under 8 characters without calling updateUser", async () => {
    await renderWithSession();
    fillAndSubmit("short12", "short12");

    await waitFor(() =>
      expect(screen.getByText("Password must be at least 8 characters.")).toBeTruthy(),
    );
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords without calling updateUser", async () => {
    await renderWithSession();
    fillAndSubmit("password-one", "password-two");

    await waitFor(() => expect(screen.getByText("Passwords do not match.")).toBeTruthy());
    expect(updateUserMock).not.toHaveBeenCalled();
  });
});

describe("reset-password — submit", () => {
  it("calls updateUser with the new password and shows the success state", async () => {
    await renderWithSession();
    fillAndSubmit("new-password-1", "new-password-1");

    await waitFor(() => expect(screen.getByText("Password updated")).toBeTruthy());
    expect(updateUserMock).toHaveBeenCalledWith({ password: "new-password-1" });
  });

  it("surfaces a Supabase error from updateUser", async () => {
    updateUserMock.mockResolvedValue({
      error: new Error("New password should be different from the old password."),
    });
    await renderWithSession();
    fillAndSubmit("same-password-1", "same-password-1");

    await waitFor(() =>
      expect(
        screen.getByText("New password should be different from the old password."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Password updated")).toBeNull();
  });
});
