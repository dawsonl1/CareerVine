// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { hardNavigate } from "@/lib/hard-navigate";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signOut: signOutMock,
    },
  }),
}));

vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));
vi.mock("@/lib/hard-navigate", () => ({ hardNavigate: vi.fn() }));

function SignOutConsumer() {
  const { signOut } = useAuth();
  return <button onClick={signOut}>sign out</button>;
}

describe("signOut redirect (CAR-45)", () => {
  beforeEach(() => {
    vi.mocked(hardNavigate).mockReset();
    signOutMock.mockReset().mockResolvedValue({ error: null });
  });

  afterEach(cleanup);

  it("signs out and redirects to the landing page", async () => {
    render(
      <AuthProvider>
        <SignOutConsumer />
      </AuthProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "sign out" }));

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/"));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("still redirects when the server sign-out call fails", async () => {
    signOutMock.mockRejectedValueOnce(new Error("network down"));

    render(
      <AuthProvider>
        <SignOutConsumer />
      </AuthProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "sign out" }));

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/"));
  });
});
