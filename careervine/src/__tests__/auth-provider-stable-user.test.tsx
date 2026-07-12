// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

// Control the Supabase auth client: getSession resolves a session, and we
// capture the onAuthStateChange callback so the test can fire the extra
// emissions Supabase sends on mount (INITIAL_SESSION, TOKEN_REFRESHED).
const { authCb, getSessionMock } = vi.hoisted(() => ({
  authCb: { current: null as null | ((event: string, session: unknown) => void) },
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authCb.current = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn(), identifyNewUser: vi.fn() }));
vi.mock("@/lib/hard-navigate", () => ({ hardNavigate: vi.fn() }));

import { AuthProvider, useAuth } from "@/components/auth-provider";

// Records the `user` reference on every render so we can assert identity stability.
const seen: Array<object | null> = [];
function Probe() {
  const { user } = useAuth();
  seen.push(user);
  return <div>{user ? (user as { id: string }).id : "none"}</div>;
}

const sess = (id: string, token = `tok-${id}`) => ({ access_token: token, user: { id } });

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe("AuthProvider reference-stable user (CAR-96)", () => {
  beforeEach(() => {
    seen.length = 0;
    getSessionMock.mockReset();
    authCb.current = null;
  });
  afterEach(cleanup);

  it("keeps the same user object across redundant same-identity auth emissions", async () => {
    getSessionMock.mockResolvedValue({ data: { session: sess("user-1") } });
    renderAuth();
    await screen.findByText("user-1");
    const afterGetSession = seen[seen.length - 1];
    expect(afterGetSession).not.toBeNull();

    // The follow-up emissions Supabase fires on mount: same id, fresh objects
    // (including a token refresh, which changes the session but not the user).
    await act(async () => authCb.current?.("INITIAL_SESSION", sess("user-1")));
    await act(async () => authCb.current?.("TOKEN_REFRESHED", sess("user-1", "tok-rotated")));

    // Same user reference throughout — downstream effects keyed on `user` never re-run.
    expect(seen[seen.length - 1]).toBe(afterGetSession);
    expect(seen.every((u) => u === null || u === afterGetSession)).toBe(true);
  });

  it("replaces the user object when the identity actually changes", async () => {
    getSessionMock.mockResolvedValue({ data: { session: sess("user-1") } });
    renderAuth();
    await screen.findByText("user-1");
    const first = seen[seen.length - 1];

    await act(async () => authCb.current?.("SIGNED_IN", sess("user-2")));
    await screen.findByText("user-2");
    const second = seen[seen.length - 1];

    expect(second).not.toBe(first);
    expect((second as { id: string }).id).toBe("user-2");
  });
});
