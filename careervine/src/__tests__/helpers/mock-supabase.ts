/**
 * Shared typed mocks for the four Supabase client modules (CAR-187).
 *
 * These were the most-mocked modules in the suite — 99 `vi.mock` sites between
 * them, every one re-rolling the same one-key module object around a different
 * hand-built query builder. The builders genuinely differ per test; the module
 * SHAPE never did, and it was the shape that could drift unnoticed.
 *
 * Each factory here returns the module's full public type (see typed-mock.ts),
 * so renaming `createSupabaseServiceClient` fails to compile at 51 call sites
 * instead of leaving them mocking an export that no longer exists.
 *
 * ── The cast ────────────────────────────────────────────────────────────────
 *
 * A hand-rolled `{ from: () => builder }` is not a `SupabaseClient`, and never
 * will be — the real type carries the whole PostgREST/GoTrue/Realtime surface.
 * The cast is unavoidable; what was avoidable was having it (or, worse, its
 * absence) spread across 99 sites. It lives here, once, in `asClient`.
 * A test's builder stays as loose as it is today; only the module boundary is
 * typed.
 *
 * ── Why the parameters are thunks ───────────────────────────────────────────
 *
 * A `vi.mock` factory body runs while the test file's imports are still being
 * evaluated, so a `const` declared later in the file is in TDZ. Passing
 * `() => authedUser` instead of `authedUser` defers the read to when the route
 * under test actually calls `getUser()`, which also preserves the existing
 * pattern where a test mutates its `authedUser` between cases.
 */
import { vi } from "vitest";
import { typedMock } from "./typed-mock";

type ServiceClientModule = typeof import("@/lib/supabase/service-client");
type ServerClientModule = typeof import("@/lib/supabase/server-client");
type BrowserClientModule = typeof import("@/lib/supabase/browser-client");
type ConfigModule = typeof import("@/lib/supabase/config");

type ServiceClient = ReturnType<ServiceClientModule["createSupabaseServiceClient"]>;
type ServerClient = Awaited<ReturnType<ServerClientModule["createSupabaseServerClient"]>>;
type BrowserClient = ReturnType<BrowserClientModule["createSupabaseBrowserClient"]>;
type SupabaseEnv = ReturnType<ConfigModule["getSupabaseEnv"]>;

/** The single sanctioned "this stub stands in for a real client" cast. */
const asClient = <T>(fake: unknown): T => fake as T;

/** Shape a test's `getUser()` needs to satisfy; anything more is passed through. */
export type FakeAuthUser = { id: string } & Record<string, unknown>;

const DEFAULT_AUTHED_USER: FakeAuthUser = { id: "user-1", email: "test@example.com" };

/**
 * `{ createSupabaseServiceClient: () => <your stub> }`.
 *
 * Called with no argument the mock returns `undefined`, exactly as the bare
 * `vi.fn()` sites did — those tests set the return value per case with
 * `vi.mocked(createSupabaseServiceClient).mockReturnValue(...)`.
 */
export function mockServiceClientModule(client?: () => unknown): ServiceClientModule {
  return typedMock<ServiceClientModule>({
    createSupabaseServiceClient: client
      ? vi.fn(() => asClient<ServiceClient>(client()))
      : vi.fn(),
  });
}

/**
 * `{ createSupabaseServerClient: async () => <an authenticated client> }`.
 *
 * The default client is the `auth.getUser()` stub that 16 sites built by hand,
 * because `withApiHandler` calls it on every request. `user` overrides who is
 * signed in (return `null` for signed-out); `client` supplies anything else the
 * route touches and is spread OVER the auth base, so it can also replace `auth`
 * outright for the routes that call something other than `getUser`.
 */
export function mockServerClientModule(opts?: {
  user?: () => FakeAuthUser | null | undefined;
  client?: () => object;
}): ServerClientModule {
  return typedMock<ServerClientModule>({
    createSupabaseServerClient: vi.fn(async () =>
      asClient<ServerClient>({
        auth: {
          getUser: vi.fn(async () => ({
            // `opts.user` present but returning null is a signed-out test, and
            // must not fall back to the default user.
            data: { user: opts?.user ? (opts.user() ?? null) : DEFAULT_AUTHED_USER },
            error: null,
          })),
        },
        ...opts?.client?.(),
      }),
    ),
  });
}

/** `{ createSupabaseBrowserClient: () => <your stub> }`. */
export function mockBrowserClientModule(client?: () => unknown): BrowserClientModule {
  return typedMock<BrowserClientModule>({
    createSupabaseBrowserClient: vi.fn(() => asClient<BrowserClient>(client ? client() : {})),
  });
}

/** `{ getSupabaseEnv: () => <a complete SupabaseEnv> }`. */
export function mockSupabaseConfigModule(env?: Partial<SupabaseEnv>): ConfigModule {
  return typedMock<ConfigModule>({
    getSupabaseEnv: vi.fn(() => ({
      url: "https://test.supabase.co",
      anonKey: "test-anon-key",
      serviceRoleKey: "test-service-role-key",
      isLocal: false,
      ...env,
    })),
  });
}
