/**
 * Shared typed mock for `@/components/auth-provider` (CAR-187).
 *
 * 16 sites mocked this module, and all 16 mocked it as
 * `{ useAuth: () => ({ user: { id: "u-1" } }) }` — a two-field lie about an
 * eight-field context, on top of a `User` that is missing every required field
 * of the real Supabase type. A component reading `session`, `loading`, or any
 * auth method got `undefined` with nothing to say so.
 *
 * `mockAuthProviderModule()` supplies the whole context (and a passthrough
 * `AuthProvider`), typed against the real module, so a new context field is a
 * compile error here rather than an `undefined` at 16 call sites.
 *
 * ── User identity stability ─────────────────────────────────────────────────
 *
 * The default `user` object is built ONCE at module load, not per `useAuth()`
 * call. That is deliberate: components run effects keyed on `user`, and a fresh
 * object per render re-fires them forever (the failure
 * auth-provider-stable-user.test.tsx exists to catch). If you override `user`,
 * build it once outside the thunk for the same reason:
 *
 *     const user = fakeUser({ id: "user-1" });
 *     vi.mock("@/components/auth-provider", () =>
 *       mockAuthProviderModule(() => ({ user })),
 *     );
 */
import React from "react";
import { vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { typedMock } from "./typed-mock";

type AuthProviderModule = typeof import("@/components/auth-provider");
/** The context `useAuth()` returns; the type itself is not exported. */
export type FakeAuthValue = ReturnType<AuthProviderModule["useAuth"]>;

/** A `User` with every field the real type requires, not just `id`. */
export function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    email: "test@example.com",
    ...overrides,
  };
}

const DEFAULT_AUTH: FakeAuthValue = {
  user: fakeUser(),
  session: null,
  loading: false,
  signUp: vi.fn(async () => ({})),
  signIn: vi.fn(async () => ({})),
  signOut: vi.fn(async () => {}),
  resetPassword: vi.fn(async () => ({})),
  resendConfirmation: vi.fn(async () => ({})),
};

/**
 * `{ useAuth, AuthProvider }` with a signed-in default.
 *
 * `overrides` is a thunk, read on every `useAuth()` call, so a test may declare
 * it after the `vi.mock` (hoisting) and mutate it between cases.
 */
export function mockAuthProviderModule(
  overrides?: () => Partial<FakeAuthValue>,
): AuthProviderModule {
  return typedMock<AuthProviderModule>({
    useAuth: () => ({ ...DEFAULT_AUTH, ...overrides?.() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  });
}
