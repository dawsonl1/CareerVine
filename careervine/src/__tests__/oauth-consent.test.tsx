// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import OAuthConsentPage from "@/app/oauth/consent/page";

/**
 * CAR-141 (R1.3): the OAuth consent screen is the only human checkpoint in
 * the MCP connect flow — approve must bind to the fetched authorization id
 * and follow the redirect, deny must actually deny, and an unauthenticated
 * visitor must be able to sign in inline without losing the request.
 */

const getDetailsMock = vi.fn();
const approveMock = vi.fn();
const denyMock = vi.fn();
const pushMock = vi.fn();
const signInMock = vi.fn();

let searchParams = new URLSearchParams("authorization_id=auth-123");
let authState: { user: { id: string } | null; loading: boolean };

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: authState.user, loading: authState.loading, signIn: signInMock }),
}));

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      oauth: {
        getAuthorizationDetails: (...args: unknown[]) => getDetailsMock(...args),
        approveAuthorization: (...args: unknown[]) => approveMock(...args),
        denyAuthorization: (...args: unknown[]) => denyMock(...args),
      },
    },
  }),
}));

const DETAILS = {
  authorization_id: "auth-123",
  client: { name: "Claude" },
  user: { email: "dawson@example.com" },
};

const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams("authorization_id=auth-123");
  authState = { user: { id: "u-1" }, loading: false };
  getDetailsMock.mockResolvedValue({ data: DETAILS, error: null });
  // jsdom's real window.location is unforgeable; swap in a plain object so
  // the page's `window.location.href = ...` redirect can be observed.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, href: "" },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  cleanup();
});

async function renderConsent() {
  render(<OAuthConsentPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());
}

describe("OAuth consent — approve/deny wiring", () => {
  it("approve calls approveAuthorization with the fetched authorization id and follows redirect_url", async () => {
    approveMock.mockResolvedValue({
      data: { redirect_url: "https://claude.ai/callback?code=ok" },
      error: null,
    });
    await renderConsent();

    expect(getDetailsMock).toHaveBeenCalledWith("auth-123");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("auth-123"));
    await waitFor(() =>
      expect(window.location.href).toBe("https://claude.ai/callback?code=ok"),
    );
    expect(denyMock).not.toHaveBeenCalled();
  });

  it("deny calls denyAuthorization and follows the returned redirect_url", async () => {
    // Production denyAuthorization always returns a redirect_url (the field is
    // required in AuthOAuthConsentResponse), so the redirect branch is the
    // real path — not the router.push fallback.
    denyMock.mockResolvedValue({
      data: { redirect_url: "https://claude.ai/callback?error=access_denied" },
      error: null,
    });
    await renderConsent();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(denyMock).toHaveBeenCalledWith("auth-123"));
    await waitFor(() =>
      expect(window.location.href).toBe("https://claude.ai/callback?error=access_denied"),
    );
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("surfaces a consent API error instead of redirecting", async () => {
    approveMock.mockResolvedValue({ data: null, error: { message: "authorization expired" } });
    await renderConsent();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("authorization expired")).toBeTruthy());
    expect(window.location.href).toBe("");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("OAuth consent — unauthenticated inline sign-in", () => {
  it("shows the sign-in form and passes the credentials to signIn", async () => {
    authState = { user: null, loading: false };
    signInMock.mockResolvedValue({});
    render(<OAuthConsentPage />);

    expect(screen.getByText("Sign in to continue")).toBeTruthy();
    // The consent request must survive sign-in — no details fetch yet.
    expect(getDetailsMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "dawson@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith("dawson@example.com", "hunter2hunter2"),
    );
  });

  it("shows the sign-in error inline", async () => {
    authState = { user: null, loading: false };
    signInMock.mockResolvedValue({ error: "Invalid login credentials" });
    render(<OAuthConsentPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrongpass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Invalid login credentials")).toBeTruthy());
  });
});

describe("OAuth consent — error states", () => {
  it("renders the details-fetch error", async () => {
    getDetailsMock.mockResolvedValue({ data: null, error: { message: "not found" } });
    render(<OAuthConsentPage />);

    await waitFor(() => expect(screen.getByText("not found")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("rejects a missing authorization_id outright", () => {
    searchParams = new URLSearchParams();
    render(<OAuthConsentPage />);

    expect(screen.getByText("Invalid authorization link.")).toBeTruthy();
    expect(getDetailsMock).not.toHaveBeenCalled();
  });
});
