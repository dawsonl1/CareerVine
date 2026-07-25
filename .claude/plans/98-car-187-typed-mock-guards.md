# CAR-187 — Typed mock guards: stop the 332 `vi.mock` factories drifting

Wave 1 of CAR-182. Test files and one CI script only: no `src/lib`, `src/app`,
or `src/components` changes.

## Research findings (empirical, not assumed)

Everything below was probed against the installed toolchain (vitest 4.1.10,
typescript 5) in this worktree, then the probe files were deleted.

1. **A full-module type annotation catches all three drift classes.** Annotating
   a factory's return as `typeof import("@/lib/x")` produces a compile error for
   (a) a missing export (TS2739), (b) a renamed/unknown export (excess property
   check), and (c) a wrong parameter type on a mocked function
   (`strictFunctionTypes` contravariance). Verified with `@ts-expect-error`
   probes that tsc consumed, plus a deliberate break that tsc reported.
2. **Bare `vi.fn()` still satisfies it.** `Mock<Procedure>` is assignable to a
   specific — even generic — export type, so migration does not force
   `vi.fn<typeof realFn>()` at every call site. (Contradicts vitest issue
   #10224's report for the `vi.mock(import(...))` form; the plain annotation
   does not have that problem.)
3. **Vitest's own typed form is weaker than what this ticket needs.**
   `vi.mock(import("@/lib/x"), factory)` types the factory as
   `ModuleMockFactoryWithHelper<M> = (importOriginal) => Awaitable<Partial<M>>`
   (`@vitest/mocker/dist/types.d-BjI5eAwu.d.ts:88`). `Partial<M>` catches renames
   but **cannot** catch a newly added export that the fake omits — which is the
   exact drift that leaves a test asserting against a fiction. So: keep the
   string form and constrain the factory ourselves.
4. **Hoisting: a factory *body* may call a statically imported helper.** Probed
   and passing. But an **argument-position** call cannot:
   `vi.mock("@/x", wrap(() => ...))` dies with
   `ReferenceError: Cannot access '__vi_import_0__' before initialization`.
   So the shared-factory call shape is `vi.mock("@/x", () => mockXModule())` —
   helper invoked *inside* the lazy factory.
5. **Test files are typechecked in CI.** `tsconfig.json` includes `**/*.ts(x)`
   and the `web` job runs `npm run typecheck`, so a drifted mock fails CI. The
   guard has teeth without new infrastructure.
6. **Local consts are still in TDZ inside the factory body** (only *imports* are
   initialized). That is why today's mocks read locals through nested arrows
   (`useToast: () => ({ error: toast.error })`). Helper override parameters are
   therefore lazy thunks wherever a call site passes a local.
7. **CAR-190 (the other `check-conventions.mjs` editor) is still `Todo`** — no
   concurrency conflict.

## Scope: 151 sites across 91 files

| Module | Sites | Dominant shape |
| -- | -- | -- |
| `@/lib/supabase/service-client` | 51 | `{ createSupabaseServiceClient: vi.fn(() => fake) }` |
| `@/lib/supabase/server-client` | 31 | 16 of them byte-identical authed-user builders |
| `@/lib/supabase/browser-client` | 17 | `{ createSupabaseBrowserClient: () => fake }` |
| `@/lib/analytics/server` | 17 | 1-2 of 6 exports stubbed |
| `@/components/auth-provider` | 16 | `{ useAuth: () => ({ user: { id: "u-1" } }) }` |
| `@/lib/analytics/client` | 11 | 1 of 4 exports stubbed |
| `@/components/ui/toast` | 10 | `{ useToast: () => ({ …6 spies }) }` |
| `@/lib/supabase/config` | 1 | included so all four Supabase modules are covered |

The long tail (181 remaining sites) is deliberately untouched.

## Work

### 1. `careervine/src/__tests__/helpers/typed-mock.ts`

`typedMock<M>(shape: M): M` — an identity function whose parameter type forces
the object literal to match the real module's **full** public shape. Header
documents finding 1, why not `satisfies` (works, but every call site has to name
the module twice), why not vitest's `import()` form (finding 3), and the
hoisting rule (findings 4/6).

### 2. Shared factories under `careervine/src/__tests__/helpers/`

- `mock-supabase.ts` — `mockServiceClientModule(client?)`,
  `mockServerClientModule({ user?, client? })`, `mockBrowserClientModule(client?)`,
  `mockSupabaseConfigModule(env?)`. The `as unknown as SupabaseClient<Database>`
  cast that every hand-rolled builder needs lives here **once**, documented,
  instead of being absent-and-untyped at 99 sites.
  `mockServerClientModule` defaults to the authed-user client the 16 identical
  sites build by hand; `user` is a thunk so the call site keeps its local
  `authedUser` variable and its per-test mutation.
- `mock-auth-provider.tsx` — `fakeUser(overrides?)` (a real `User`, not
  `{ id: "u-1" }`) and `mockAuthProviderModule(overrides?: () => Partial<Auth>)`,
  which supplies all eight context fields plus a passthrough `AuthProvider`.
- `mock-toast.tsx` — `toastMock` (singleton spies, assertable by importers) and
  `mockToastModule(overrides?: () => Partial<ToastContextValue>)`, plus a
  passthrough `ToastProvider`.
- `mock-analytics.ts` — `mockAnalyticsServerModule(overrides?)` /
  `mockAnalyticsClientModule(overrides?)` with all 6 + 4 exports stubbed.

### 3. Migrate the 151 call sites

Mechanical, guided by `tsc`. Every migrated site becomes
`vi.mock("@/x", () => mockXModule(…))`. Behaviour must not change: where a fake
currently returns `undefined` (`createSupabaseServiceClient: vi.fn()`), the
helper default reproduces exactly that.

### 4. Guard (f) in `careervine/scripts/check-conventions.mjs`

New AST visitor over test files (the inverse of the existing checks' scope): a
`vi.mock` of a module on the shared-factory list must use that module's factory.
Handles both the string and `import()` first-argument forms. Escape hatch
`// typed-mock-exempt: <reason>`, matching the file's existing two-hatch style.
Cases added to `careervine/src/__tests__/check-conventions.test.ts` — one that
must trip, one clean control, one exempt.

### 5. Proof the type guard bites

`careervine/src/__tests__/typed-mock.type-test.ts` — `@ts-expect-error` probes
for missing export / renamed export / wrong signature, so the guarantee is
asserted permanently rather than demonstrated once. Plus the ticket's manual
check: change a real function's signature, confirm the suite fails to compile,
revert.

### 6. Docs

CONVENTIONS.md §h: name the new helpers and say what enforces them (§h currently
says the unit tier's conventions are not mechanically enforced — that stops
being true). `conventions-doc.test.ts` asserts every cited path exists.

## Verify

- `npm run test` (full suite, from `careervine/`)
- `npm run typecheck`
- `npm run check:conventions`
- `npx eslint . --max-warnings 0`
- guard proof: reintroduce a violation → non-zero exit naming file and line
- type proof: change `trackCronError`'s signature → typecheck fails
