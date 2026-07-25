/**
 * Shared typed mock for `@/components/ui/toast` (CAR-187).
 *
 * Ten sites re-declared the same six-spy context object, three of them
 * incompletely (`{ toast }` alone, `{ success, error }` alone) — so a component
 * that started calling `warning()` would have thrown `not a function` in those
 * files and passed in the others.
 *
 * `toastMock` is a module-scoped singleton, which is what makes the common case
 * a one-liner: a test can assert on `toastMock.error` without threading spies
 * through the factory. Vitest gives each test FILE its own module registry, so
 * the singleton is per-file; within a file, clear it the way these suites
 * already do, with `vi.clearAllMocks()` in `beforeEach`. Use the `overrides`
 * thunk when a test needs its own spy identity (or a spy that also does work).
 */
import React from "react";
import { vi } from "vitest";
import { typedMock } from "./typed-mock";

type ToastModule = typeof import("@/components/ui/toast");
/** The context `useToast()` returns; the interface itself is not exported. */
export type FakeToastValue = ReturnType<ToastModule["useToast"]>;

/** The spies every `useToast()` call returns unless a test overrides them. */
export const toastMock = {
  toast: vi.fn<FakeToastValue["toast"]>(() => ""),
  dismiss: vi.fn<FakeToastValue["dismiss"]>(),
  success: vi.fn<FakeToastValue["success"]>(),
  error: vi.fn<FakeToastValue["error"]>(),
  info: vi.fn<FakeToastValue["info"]>(),
  warning: vi.fn<FakeToastValue["warning"]>(),
};

/**
 * `{ useToast, ToastProvider }`.
 *
 * `overrides` is a thunk, read on every `useToast()` call, so a test may pass
 * spies it declares after the hoisted `vi.mock`.
 */
export function mockToastModule(overrides?: () => Partial<FakeToastValue>): ToastModule {
  return typedMock<ToastModule>({
    useToast: () => ({ ...toastMock, ...overrides?.() }),
    ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  });
}
