/**
 * Routes that render for signed-out visitors. Everything not listed here is
 * an authenticated app page: SignedOutRedirect bounces sessionless visitors
 * back to the landing page instead of letting the page render a dead shell
 * with a self-hidden navbar (CAR-64).
 */

// Exact paths that must stay reachable without a session.
const PUBLIC_PATHS = new Set([
  "/", // landing page renders here when signed out
  "/privacy",
  "/terms",
  "/reset-password", // recovery flow establishes its own session
  "/contacts/preview", // extension preview — renders an inline AuthForm
]);

// Path prefixes (segment-aware) that own their own auth handling:
// /auth/* is the sign-in surface itself; /oauth/consent renders an inline
// sign-in form mid-flow for MCP OAuth and must never be redirected away.
const PUBLIC_PREFIXES = ["/auth", "/oauth"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
