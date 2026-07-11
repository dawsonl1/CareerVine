// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SignedOutRedirect } from "@/components/signed-out-redirect";
import { hardNavigate } from "@/lib/hard-navigate";

const { authState, pathnameMock } = vi.hoisted(() => ({
  authState: { user: null as object | null, loading: false },
  pathnameMock: vi.fn<() => string>(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => authState,
}));

vi.mock("next/navigation", () => ({
  usePathname: pathnameMock,
}));

vi.mock("@/lib/hard-navigate", () => ({ hardNavigate: vi.fn() }));

function renderGuard() {
  return render(
    <SignedOutRedirect>
      <div>app content</div>
    </SignedOutRedirect>
  );
}

describe("SignedOutRedirect (CAR-64)", () => {
  beforeEach(() => {
    vi.mocked(hardNavigate).mockReset();
    authState.user = null;
    authState.loading = false;
    pathnameMock.mockReturnValue("/contacts");
  });

  afterEach(cleanup);

  it("redirects to the landing page and hides the dead shell when signed out on an app page", () => {
    renderGuard();

    expect(hardNavigate).toHaveBeenCalledWith("/");
    expect(screen.queryByText("app content")).toBeNull();
  });

  it("renders children while auth state is still loading", () => {
    authState.loading = true;

    renderGuard();

    expect(hardNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("app content")).toBeTruthy();
  });

  it("renders children when signed in", () => {
    authState.user = { id: "user-1" };

    renderGuard();

    expect(hardNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("app content")).toBeTruthy();
  });

  it("leaves signed-out visitors alone on public pages", () => {
    for (const path of ["/", "/auth", "/oauth/consent", "/contacts/preview", "/privacy"]) {
      pathnameMock.mockReturnValue(path);

      renderGuard();

      expect(hardNavigate, path).not.toHaveBeenCalled();
      expect(screen.getByText("app content"), path).toBeTruthy();
      cleanup();
    }
  });
});
