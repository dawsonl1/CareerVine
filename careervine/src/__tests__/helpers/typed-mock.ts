/**
 * Typed `vi.mock` factories (CAR-187).
 *
 * `vi.mock(path, factory)` does not typecheck the factory's return against the
 * module it replaces. So this compiles, and keeps compiling forever:
 *
 *     vi.mock("@/lib/queries", () => ({ getContactsStreamed: vi.fn() }));
 *
 * after `getContactsStreamed` is renamed, gains a required argument, changes
 * its return shape, or is joined by a new export the fake never provides. The
 * test then asserts the component's behaviour against a fiction of the module,
 * and tsc cannot see the gap. That is the mechanism by which a suite stays
 * green while the app breaks.
 *
 * `typedMock<M>()` closes it by giving the object literal a contextual type.
 * Three drift classes become compile errors (each one is pinned in
 * typed-mock.type-test.ts):
 *
 *   1. an export the fake omits          → TS2739 missing properties
 *   2. an export the fake renamed/typo'd → excess property check
 *   3. a mocked function's signature     → strictFunctionTypes contravariance
 *
 * A bare `vi.fn()` still satisfies any export type, generic ones included, so
 * this costs call sites nothing beyond naming the module once.
 *
 * ── Shared factory, or a one-off ────────────────────────────────────────────
 *
 * The eight most-mocked modules already have a module-typed factory in this
 * directory, and a mock of one of them goes through that factory rather than
 * hand-rolling an object literal: the four Supabase modules
 * (`@/lib/supabase/service-client`, `/server-client`, `/browser-client`,
 * `/config`), `@/components/auth-provider`, `@/components/ui/toast`, and the
 * two analytics modules (`@/lib/analytics/server`, `/client`). Each returns its
 * module's FULL type, so every one of those call sites inherits the constraint
 * above without naming the module itself. `SHARED_MOCK_FACTORIES` in
 * scripts/check-conventions.mjs is the module → factory mapping, and the check
 * beside it fails a `vi.mock` of one of the eight that does not CALL its
 * factory (escape hatch: a `typed-mock-exempt: <reason>` line comment above the
 * mock).
 *
 * Any other module gets the same guarantee one call site at a time, through
 * `typedMock<typeof import("…")>()` below.
 *
 * ── Why not the alternatives ────────────────────────────────────────────────
 *
 * `satisfies typeof import("@/lib/x")` on the factory body does the same job
 * natively, and is fine for a one-off. It reads worse at scale (the module is
 * named twice, once in the path and once in the assertion) and gives no place
 * to hang this comment.
 *
 * Vitest's own typed form, `vi.mock(import("@/lib/x"), factory)`, is WEAKER
 * than it looks: the factory is typed
 * `ModuleMockFactoryWithHelper<M> = (importOriginal) => Awaitable<Partial<M>>`
 * (@vitest/mocker types.d.ts). `Partial<M>` catches a rename but cannot catch a
 * newly ADDED export the fake does not provide — and since a factory REPLACES
 * the module rather than merging into it, that missing export is `undefined` at
 * runtime for every caller. Missing-export drift is the class this ticket
 * exists to stop, so the constraint has to be the full module type.
 *
 * ── Hoisting: where a helper may be called ──────────────────────────────────
 *
 * Vitest hoists `vi.mock(...)` above the file's imports, so a call in ARGUMENT
 * position runs before its own import is initialized:
 *
 *     vi.mock("@/lib/x", mockXModule());   // ReferenceError: Cannot access
 *                                          // '__vi_import_0__' before init
 *
 * The factory BODY, though, runs lazily — when the module under test is first
 * imported, by which time imported bindings are live. So the shape is always:
 *
 *     vi.mock("@/lib/x", () => mockXModule());
 *
 * Locals declared in the test file are still in TDZ inside that body (only
 * imports are initialized), which is why the shared factories in this directory
 * take their per-test overrides as thunks: the thunk defers the read to hook or
 * client-construction time, long after the file body has run.
 */

/**
 * Constrain a mock factory's shape to the real module's full public type.
 *
 *     vi.mock("@/lib/crypto", () =>
 *       typedMock<typeof import("@/lib/crypto")>({
 *         encryptToken: vi.fn(),
 *         decryptToken: vi.fn(),
 *       }),
 *     );
 *
 * Identity at runtime; the whole point is the parameter's type. `M` must be
 * given explicitly — inferring it from the argument would make the check
 * vacuous, since the argument would then define the very type it is checked
 * against.
 */
export function typedMock<M>(shape: M): M {
  return shape;
}
