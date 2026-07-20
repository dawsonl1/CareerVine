/**
 * Compile-time regression guard for CAR-149 F20: `withApiHandler`'s `user`
 * type must depend on `authOptional`. This is NOT a runtime test — the
 * filename has no `.test.ts` suffix, so vitest ignores it — but `tsc --noEmit`
 * (and `next build`) type-check it. If the authOptional null-safety regresses,
 * the `@ts-expect-error` below stops suppressing a real error, becomes an
 * "unused directive" (TS2578), and fails the build.
 */
import { withApiHandler, type InferApiResponse } from "@/lib/api-handler";

// Authenticated route (no authOptional): `user` is a non-null `User`, so
// `user.id` needs no guard. If this stopped compiling, the default typing broke.
withApiHandler({
  handler: async ({ user }) => {
    const id: string = user.id;
    return { id };
  },
});

// authOptional route: `user` is `User | null`. Dereferencing without a guard
// MUST be a compile error — that is the whole point of F20.
withApiHandler({
  authOptional: true,
  handler: async ({ user }) => {
    // @ts-expect-error user is `User | null` under authOptional; a null guard is required
    const id: string = user.id;
    return { id };
  },
});

// The real usage pattern (null-guarded) compiles cleanly under authOptional.
withApiHandler({
  authOptional: true,
  handler: async ({ user }) => {
    const id: string | null = user ? user.id : null;
    return { id };
  },
});

// ── CAR-158 F24: the TResponse seam ──────────────────────────────────────
//
// TResponse is inferred from the handler's return, so a route's success shape
// is recoverable by its consumers via InferApiResponse<typeof GET> and cannot
// drift from what the handler actually returns.

const countRoute = withApiHandler({
  handler: async () => ({ count: 1 }),
});
void countRoute; // referenced as a value so no-unused-vars sees the use

type CountResponse = InferApiResponse<typeof countRoute>;

// The inferred shape is the handler's return, NOT `unknown` — assigning a
// concrete object to it compiles.
const okCount: CountResponse = { count: 5 };
void okCount;

// A field the handler never returns is a compile error. If TResponse
// regressed to `unknown`, this @ts-expect-error would go unused and TS2578
// would fail the build.
// @ts-expect-error `total` is not part of the inferred response shape
const wrongCount: CountResponse = { total: 5 };
void wrongCount;

// InferApiResponse strips ApiErrorBody out of the union, so consumers get the
// success shape alone rather than `TResponse | ApiErrorBody`. Were the error
// body leaking through, `count` would not be a required property and this
// empty-object assignment would compile.
// @ts-expect-error the success shape requires `count`; ApiErrorBody must not widen it
const notAnError: CountResponse = {};
void notAnError;

// A handler declaring an explicit return type is checked against it, so a
// route that stops returning its declared shape fails tsc at the route rather
// than at some distant consumer.
withApiHandler({
  handler: async (): Promise<{ items: string[] }> => {
    // @ts-expect-error `items` must be string[], not number[]
    return { items: [1, 2, 3] };
  },
});
