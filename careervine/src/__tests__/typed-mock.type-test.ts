/**
 * Compile-time proof that the CAR-187 mock guard actually bites.
 *
 * NOT a runtime test — no `.test.ts` suffix, so vitest ignores the file — but
 * `tsc --noEmit` (the `web` CI job) and `next build` both typecheck it. Each
 * `@ts-expect-error` below asserts that a specific kind of mock drift is a
 * compile error. If the constraint ever weakens, the directive stops
 * suppressing anything, becomes an unused directive (TS2578), and CI goes red.
 *
 * A guard that cannot be shown to trip is indistinguishable from one that does
 * nothing — the same reasoning that produced check-conventions.test.ts.
 */
import { vi } from "vitest";
import { typedMock } from "./helpers/typed-mock";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServerClientModule } from "./helpers/mock-supabase";

type AnalyticsServer = typeof import("@/lib/analytics/server");

// ── The three drift classes ──────────────────────────────────────────────

// 1. A fake that omits an export. This is the one vitest's own
//    `vi.mock(import(...), factory)` form CANNOT catch, because it types the
//    factory as Partial<M> — and a factory REPLACES the module, so every
//    omitted export is `undefined` at runtime.
//    (Reported on the argument, not the property — the object simply is not
//    assignable — so the directive sits on the call.)
// @ts-expect-error missing exports: the fake must cover the whole module
typedMock<AnalyticsServer>({ trackServer: vi.fn() });

// 2. A fake naming an export the module does not have (a rename, or a typo).
typedMock<AnalyticsServer>({
  trackServer: vi.fn(),
  trackCronError: vi.fn(),
  reachMilestone: vi.fn(),
  checkContactMilestone: vi.fn(),
  checkCompaniesEmailedMilestone: vi.fn(),
  _resetAnalyticsForTests: vi.fn(),
  // @ts-expect-error `trackServerr` is not an export of the module
  trackServerr: vi.fn(),
});

// 3. A fake whose signature disagrees with the real one. `trackCronError`
//    takes (route: string); a stub that expects a number is a compile error,
//    which is what stops a test passing against a call shape the app no longer
//    makes.
typedMock<AnalyticsServer>({
  trackServer: vi.fn(),
  // @ts-expect-error wrong parameter type for trackCronError(route: string)
  trackCronError: vi.fn(async (n: number) => {
    void n;
  }),
  reachMilestone: vi.fn(),
  checkContactMilestone: vi.fn(),
  checkCompaniesEmailedMilestone: vi.fn(),
  _resetAnalyticsForTests: vi.fn(),
});

// ── What must keep compiling ─────────────────────────────────────────────

// A complete fake, with bare `vi.fn()` for every export including the generic
// one. If this broke, migration would cost every call site a `vi.fn<typeof x>()`
// and the guard would be paid for twice.
typedMock<AnalyticsServer>({
  trackServer: vi.fn(),
  trackCronError: vi.fn(),
  reachMilestone: vi.fn(),
  checkContactMilestone: vi.fn(),
  checkCompaniesEmailedMilestone: vi.fn(),
  _resetAnalyticsForTests: vi.fn(),
});

// ── The shared factories inherit the same guarantee ──────────────────────

// Overrides are typed against the real module, so a typo'd key is caught even
// though the factory supplies the rest of the shape.
// @ts-expect-error `trackSever` is not an export of @/lib/analytics/server
mockAnalyticsServerModule({ trackSever: vi.fn() });

// The authed-user thunk must return something with an `id` — a user object
// missing it reads as "signed in" while every `user.id` in the route is
// undefined.
// @ts-expect-error a fake auth user needs an id
mockServerClientModule({ user: () => ({ email: "nobody@example.com" }) });

// And the ordinary calls stay ordinary.
mockAnalyticsServerModule();
mockAnalyticsServerModule({ trackServer: vi.fn(async () => {}) });
mockServerClientModule();
mockServerClientModule({ user: () => null });
mockServerClientModule({ user: () => ({ id: "u-1" }), client: () => ({ from: () => ({}) }) });
