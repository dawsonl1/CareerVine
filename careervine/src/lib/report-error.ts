/**
 * The single reporting seam for caught render errors (CAR-184).
 *
 * Every error boundary in the app funnels through `reportBoundaryError` so that
 * wiring a real error tracker later is a one-file change instead of a sweep.
 *
 * Today it only `console.error`s. That is deliberate, not an oversight: no Sentry
 * SDK is installed in the web app (`@sentry/*` appears nowhere in `src` or
 * `package.json`), and CAR-184 scoped adding one out of its diff. `$SENTRY_AUTH_TOKEN`
 * and the `na-ui4` org exist, so the follow-up is real work, just not this work.
 *
 * This module must stay dependency-free, and that is ENFORCED: the import assertion
 * in `src/__tests__/error-boundaries.test.tsx` fails if this file grows a single
 * static import. `global-error.tsx` imports this module, and that file replaces the
 * root layout when it renders, so it cannot assume the design system, the eight
 * context providers, or even the global stylesheet are alive. There is also no
 * boundary BELOW global-error, so a tracker SDK that threw during module init would
 * take out the last-resort page itself.
 *
 * So when a tracker is wired here, do not add a top-level import. Load it lazily
 * inside the function, at the moment of reporting, where the try/catch below already
 * contains a failure:
 *
 *     void import("@sentry/nextjs").then((s) => s.captureException(error)).catch(() => {});
 *
 * That keeps the SDK out of the last-resort page's module-init path. The alternative,
 * a separate reporter used only by the non-global boundaries, is also fine, but then
 * global-error silently stops reporting, which is the surface you least want blind.
 *
 * The `[boundary]` prefix is load-bearing for log search, so keep it stable.
 */

/** Where in the tree the error was caught, for triage in the logs. */
export type BoundaryScope =
  | "root"
  | "global"
  | "admin"
  | "section";

/**
 * Report an error caught by a React error boundary.
 *
 * Never throws: a reporter that fails must not take down the fallback UI that is
 * already the last line of defense. `digest` is Next's server-side log
 * correlation hash, present on errors forwarded from Server Components.
 */
export function reportBoundaryError(
  scope: BoundaryScope,
  error: unknown,
  context?: { label?: string; digest?: string }
): void {
  try {
    const digest =
      context?.digest ??
      (typeof error === "object" && error !== null && "digest" in error
        ? String((error as { digest?: unknown }).digest ?? "")
        : "");

    const where = context?.label ? `${scope}:${context.label}` : scope;

    console.error(
      `[boundary] ${where}${digest ? ` digest=${digest}` : ""}`,
      error
    );
  } catch {
    // Reporting is best-effort by definition. Swallow.
  }
}
