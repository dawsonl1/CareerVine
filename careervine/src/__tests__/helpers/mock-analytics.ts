/**
 * Shared typed mocks for the two analytics modules (CAR-187).
 *
 * 28 sites mocked these, none of them completely: the usual factory stubbed
 * `trackServer` and left the other five exports off the module entirely. That
 * is a live trap rather than a cosmetic one — analytics calls are fire-and-
 * forget side effects, so a route reaching a milestone helper that the mock
 * never defined throws inside the handler and surfaces as an unrelated 500.
 *
 * Both factories stub every export, typed against the real module, so an export
 * added to `@/lib/analytics/server` fails to compile here once instead of
 * failing at runtime in whichever suite happens to hit that code path.
 *
 * Overrides are a plain object (not a thunk, unlike the hook mocks) because the
 * module shape is built when the mocked module is first imported. Pass a
 * closure, never a bare local — `{ trackServer: (...a) => trackSpy(...a) }`
 * defers the read; `{ trackServer: trackSpy }` reads a still-uninitialized
 * const. See typed-mock.ts for the hoisting rule.
 */
import { vi } from "vitest";
import { typedMock } from "./typed-mock";

type AnalyticsServerModule = typeof import("@/lib/analytics/server");
type AnalyticsClientModule = typeof import("@/lib/analytics/client");

/** Server-side spies, shared by every site that does not override them. */
export const analyticsServerMock = {
  trackServer: vi.fn(async () => {}),
  trackCronError: vi.fn(async () => {}),
  reachMilestone: vi.fn(async () => {}),
  checkContactMilestone: vi.fn(async () => {}),
  checkCompaniesEmailedMilestone: vi.fn(async () => {}),
  _resetAnalyticsForTests: vi.fn(),
};

/** Client-side spies, shared by every site that does not override them. */
export const analyticsClientMock = {
  ensureInit: vi.fn(() => true),
  track: vi.fn(),
  trackBeforeNavigate: vi.fn(),
  identifyNewUser: vi.fn(),
};

export function mockAnalyticsServerModule(
  overrides?: Partial<AnalyticsServerModule>,
): AnalyticsServerModule {
  return typedMock<AnalyticsServerModule>({ ...analyticsServerMock, ...overrides });
}

export function mockAnalyticsClientModule(
  overrides?: Partial<AnalyticsClientModule>,
): AnalyticsClientModule {
  return typedMock<AnalyticsClientModule>({ ...analyticsClientMock, ...overrides });
}
