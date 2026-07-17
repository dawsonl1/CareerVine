/**
 * Compile-time regression guard for CAR-149 F20: `withApiHandler`'s `user`
 * type must depend on `authOptional`. This is NOT a runtime test — the
 * filename has no `.test.ts` suffix, so vitest ignores it — but `tsc --noEmit`
 * (and `next build`) type-check it. If the authOptional null-safety regresses,
 * the `@ts-expect-error` below stops suppressing a real error, becomes an
 * "unused directive" (TS2578), and fails the build.
 */
import { withApiHandler } from "@/lib/api-handler";

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
