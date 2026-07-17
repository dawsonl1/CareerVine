/**
 * Centralized API route handler with auth, Zod validation, and error handling.
 *
 * Usage:
 *   export const POST = withApiHandler({
 *     schema: myBodySchema,
 *     handler: async ({ user, supabase, body }) => {
 *       return { myData: 123 };
 *     },
 *   });
 *
 * ── Route conventions this wrapper settles (CAR-149) ─────────────────────
 *
 * • authOptional typing: `authOptional: true` handlers receive `user: User |
 *   null` at compile time; every other route receives a non-null `User`. This
 *   is enforced by the two overloads below — no `as User` casts needed.
 *
 * • paramsSchema: validate dynamic `[id]` params declaratively (a bad param is
 *   a 400) instead of hand-rolling `Number(params.x)` + isNaN in each route.
 *
 * • One success shape: JSON success responses use `{ success: true, ... }` (not
 *   `ok: true`). Callers that need a boolean should read the HTTP status. Admin
 *   routes keep their own internally consistent convention.
 *
 * • Curated errors only: never interpolate a raw DB/driver `error.message` into
 *   an ApiError message or a client-visible `errors[]` entry — those can leak
 *   schema/internal detail. Throw a curated, user-safe message and log the raw
 *   error with console.error for diagnosis.
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { getExtensionAuth, corsHeaders } from "@/lib/extension-auth";
import { checkRateLimit, type RateLimitOptions } from "@/lib/rate-limit";
import { resolveCapabilities, type Capability } from "@/lib/capabilities";
import { trackServer } from "@/lib/analytics/server";
import type { AnalyticsEvent, AnalyticsEvents } from "@/lib/analytics/events";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    /** Optional machine-readable code so clients can map errors to UX copy. */
    public code?: string,
    /**
     * Optional response headers to attach when this error becomes a response
     * (e.g. Retry-After on a 429). The wrapper's catch merges these over the
     * base headers — the only way a thrown ApiError can carry a header out
     * through the uniform catch path (CAR-149).
     */
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface HandlerContext<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
  TUser = User,
> {
  request: NextRequest;
  user: TUser;
  supabase: SupabaseClient;
  body: TBody;
  query: TQuery;
  params: TParams;
  /**
   * Record a product-analytics event for the authenticated user (CAR-38).
   * Fire-and-forget from the handler's perspective — the wrapper awaits all
   * pending captures after the handler returns, so events survive the
   * serverless freeze without the handler blocking on them.
   */
  track: <E extends AnalyticsEvent>(event: E, props: AnalyticsEvents[E]) => void;
  /**
   * Defer arbitrary non-critical async work (already-started promise) past
   * the response (CAR-78). Same flush guarantee as track: the wrapper awaits
   * it in finally, so it completes before the lambda freezes but never
   * blocks the handler. Rejections are swallowed.
   */
  defer: (p: Promise<unknown>) => void;
}

/** Config shared by both overloads — everything except the auth-typed handler. */
interface BaseRouteConfig<TBody, TQuery, TParams> {
  /** Zod schema for the JSON request body (POST/PUT/PATCH). */
  schema?: ZodSchema<TBody>;
  /** Zod schema for URL search params. Values arrive as strings. */
  querySchema?: ZodSchema<TQuery>;
  /**
   * Zod schema for the dynamic route params (`context.params`, e.g. `[id]`).
   * Values arrive as strings; use `z.coerce` for numeric ids. A parse failure
   * is a 400 — the single declarative place to reject a malformed `[id]`
   * instead of a hand-rolled `Number()` + isNaN in every route (CAR-149, F47).
   * When unset, `params` stays `Record<string, string>`.
   */
  paramsSchema?: ZodSchema<TParams>;
  /** Use Chrome-extension auth (Bearer token or cookie). */
  extensionAuth?: boolean;
  /**
   * When false, Bearer-authed calls to this route do NOT stamp
   * users.extension_last_seen_at (CAR-68). Set on extensionAuth routes that
   * are really driven by ops scripts/the web app rather than the extension,
   * so a bulk-import run can't fake an "extension connected" signal.
   * Defaults to true.
   */
  stampExtensionSeen?: boolean;
  /** Include CORS headers on the response. */
  cors?: boolean;
  /** When true, the authenticated user must carry app_metadata.role === 'admin' or the request is rejected with 403. */
  requireAdmin?: boolean;
  /**
   * Require a CAR-103 capability. The user's capability set is resolved
   * server-side (service-role read of the entitlement flags); a missing
   * capability is rejected with 403. Fails closed for an authOptional route
   * with no user (403, never a 500). Generalizes requireAdmin.
   */
  requireCapability?: Capability;
  /**
   * Opt-in per-user rate limit (CAR-41), checked right after auth resolves.
   * Skipped when there is no user (authOptional). On exceeded the wrapper
   * returns 429 `{ error, code: 'rate_limited', resetAt }` with Retry-After.
   */
  rateLimit?: RateLimitOptions;
}

type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<Record<string, string>> },
) => Promise<NextResponse>;

// ── Helpers ────────────────────────────────────────────────────────────

function formatZodErrors(error: ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    })
    .join("; ");
}

function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
) {
  return NextResponse.json(data, {
    status,
    headers: extraHeaders,
  });
}

// ── Core wrapper ───────────────────────────────────────────────────────
//
// Two overloads key the handler's `user` type on the `authOptional` literal so
// the compiler tells the truth about nullability (CAR-149, F20): an authOptional
// route may see `null`; every other route is guaranteed a non-null `User`.

/** authOptional: true → the handler receives `user: User | null` (may be null). */
export function withApiHandler<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
>(
  config: BaseRouteConfig<TBody, TQuery, TParams> & {
    /** Auth is attempted but the handler runs even if no user resolves. */
    authOptional: true;
    handler: (
      ctx: HandlerContext<TBody, TQuery, TParams, User | null>,
    ) => Promise<unknown>;
  },
): RouteHandler;

/** Default: an authenticated route → the handler receives a non-null `User`. */
export function withApiHandler<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
>(
  config: BaseRouteConfig<TBody, TQuery, TParams> & {
    authOptional?: false;
    handler: (
      ctx: HandlerContext<TBody, TQuery, TParams, User>,
    ) => Promise<unknown>;
  },
): RouteHandler;

// The implementation signature must be assignable-from BOTH overloads, whose
// handler `user` types (User vs User | null) are mutually incompatible under
// strictFunctionTypes — so the handler ctx here is intentionally `any` (which
// is bivariant and unifies both). Only the two overloads above are callable
// externally; they carry all the real type safety. Inside, `user` is narrowed
// to `User | null` by hand.
export function withApiHandler(config: {
  schema?: ZodSchema<unknown>;
  querySchema?: ZodSchema<unknown>;
  paramsSchema?: ZodSchema<unknown>;
  extensionAuth?: boolean;
  stampExtensionSeen?: boolean;
  cors?: boolean;
  authOptional?: boolean;
  requireAdmin?: boolean;
  requireCapability?: Capability;
  rateLimit?: RateLimitOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-149: `any` user makes the ctx param bivariant so both overloads (User vs User|null) unify
  handler: (ctx: HandlerContext<any, any, any, any>) => Promise<unknown>;
}): RouteHandler {
  return async (
    request: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    const headers = config.cors ? corsHeaders : undefined;

    // Analytics captures started during this request; awaited (never thrown)
    // before the response goes out so the lambda doesn't freeze mid-flush.
    const pendingTracks: Promise<void>[] = [];
    let trackUserId: string | null = null;

    try {
      // ── Auth ────────────────────────────────────────────────────
      // Null only when authOptional resolves no user (an early 401 otherwise),
      // so the overloads above hand a non-null User to every other route.
      let user: User | null;
      let supabase: SupabaseClient;

      if (config.extensionAuth) {
        const auth = await getExtensionAuth(request);
        if (auth.error) return auth.error;
        user = auth.user;
        supabase = auth.supabase;
        // CAR-68: Bearer-authed calls come from the Chrome extension (cookie
        // fallback is the web app's bulk importer). Stamp last-seen so the
        // onboarding "log in to the extension" step can detect the connection.
        // Fire-and-forget: a failed stamp must never affect the request.
        if (
          config.stampExtensionSeen !== false &&
          request.headers.get("Authorization")?.startsWith("Bearer ")
        ) {
          pendingTracks.push(
            Promise.resolve(
              supabase
                .from("users")
                .update({ extension_last_seen_at: new Date().toISOString() })
                .eq("id", user.id),
            ).then(() => undefined, () => undefined),
          );
        }
      } else {
        supabase = await createSupabaseServerClient();
        const {
          data: { user: u },
          error: authError,
        } = await supabase.auth.getUser();
        if (!u || authError) {
          if (config.authOptional) {
            user = null;
          } else {
            return jsonResponse({ error: "Unauthorized" }, 401, headers);
          }
        } else {
          user = u;
          // CAR-105: throttled web last-active stamp — the signal the active-aware
          // follow-up expiry depends on. Conditional so it writes at most ~once/hour;
          // NOT a rule-17 CAS trap (the result is never read). Wrapped so it can NEVER
          // affect the request: the whole stamp is a caught best-effort promise, so a
          // missing method (minimal test mocks), a malformed filter, or a DB error just
          // no-ops (worst case: items stop expiring, which is non-destructive). Needs
          // the GRANT UPDATE(web_last_seen_at) in 20260712070000. The threshold is
          // millisecond-stripped so its dot-free value can't confuse PostgREST's .or().
          const stampUserId = user.id;
          pendingTracks.push(
            (async () => {
              try {
                const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
                  .toISOString()
                  .replace(/\.\d{3}Z$/, "Z");
                await supabase
                  .from("users")
                  .update({ web_last_seen_at: new Date().toISOString() })
                  .eq("id", stampUserId)
                  .or(`web_last_seen_at.is.null,web_last_seen_at.lt.${oneHourAgo}`);
              } catch {
                // best-effort; never affects the request
              }
            })(),
          );
        }
      }

      // ── Admin gate ──────────────────────────────────────────────
      // The admin claim lives in auth.users.app_metadata.role (service-role
      // writable only), so it cannot be spoofed by the client.
      if (config.requireAdmin) {
        const role = user?.app_metadata?.role;
        if (role !== "admin") {
          return jsonResponse({ error: "Forbidden" }, 403, headers);
        }
      }

      // ── Capability gate (CAR-103) ───────────────────────────────
      // Generalizes the admin gate to the capability model. The set is
      // resolved server-side; a missing capability is a 403. Null-guarded so
      // an authOptional route with no user fails closed to 403, not a 500.
      if (config.requireCapability) {
        const capUserId = user?.id;
        const caps = capUserId
          ? await resolveCapabilities(capUserId)
          : new Set<Capability>();
        if (!caps.has(config.requireCapability)) {
          return jsonResponse(
            { error: "Forbidden", capability: config.requireCapability },
            403,
            headers,
          );
        }
      }

      // ── Rate limit ──────────────────────────────────────────────
      // Runs before body parse so over-limit requests stay cheap. The 429
      // is returned directly (not thrown as ApiError) because it needs the
      // Retry-After header on the response.
      const rateLimitUserId = user?.id;
      if (config.rateLimit && rateLimitUserId) {
        const rate = await checkRateLimit(rateLimitUserId, config.rateLimit);
        if (!rate.allowed) {
          // resetAt null = the limiter itself is unavailable (fail-closed
          // denial, CAR-143) — advertise a conservative retry, not 1s, so
          // clients don't hammer through an outage.
          const retryAfterSec = rate.resetAt
            ? Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
            : 60;
          return jsonResponse(
            {
              error: "Rate limit exceeded. Please try again later.",
              code: "rate_limited",
              resetAt: rate.resetAt,
            },
            429,
            { ...headers, "Retry-After": String(retryAfterSec) },
          );
        }
      }

      // ── Path params ─────────────────────────────────────────────
      const rawParams = context?.params ? await context.params : {};
      let params: unknown = rawParams;
      if (config.paramsSchema) {
        const result = config.paramsSchema.safeParse(rawParams);
        if (!result.success) {
          return jsonResponse(
            { error: formatZodErrors(result.error) },
            400,
            headers,
          );
        }
        params = result.data;
      }

      // ── Body validation ─────────────────────────────────────────
      let body: unknown = {};
      if (config.schema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonResponse(
            { error: "Invalid or missing JSON body" },
            400,
            headers,
          );
        }
        const result = config.schema.safeParse(raw);
        if (!result.success) {
          return jsonResponse(
            { error: formatZodErrors(result.error) },
            400,
            headers,
          );
        }
        body = result.data;
      }

      // ── Query validation ────────────────────────────────────────
      let query: unknown = {};
      if (config.querySchema) {
        const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
        const result = config.querySchema.safeParse(raw);
        if (!result.success) {
          return jsonResponse(
            { error: formatZodErrors(result.error) },
            400,
            headers,
          );
        }
        query = result.data;
      }

      // ── Handler ─────────────────────────────────────────────────
      trackUserId = user?.id ?? null;
      const data = await config.handler({
        request,
        user,
        supabase,
        body,
        query,
        params,
        track: (event, props) => {
          pendingTracks.push(trackServer(trackUserId, event, props));
        },
        defer: (p) => {
          pendingTracks.push(p.then(() => undefined, () => undefined));
        },
      });

      // Allow handlers to return a NextResponse directly (e.g. redirects)
      if (data instanceof NextResponse) return data;

      return jsonResponse(data, 200, headers);
    } catch (error) {
      // Known API errors thrown intentionally
      if (error instanceof ApiError) {
        return jsonResponse(
          error.code
            ? { error: error.message, code: error.code }
            : { error: error.message },
          error.status,
          error.headers ? { ...headers, ...error.headers } : headers,
        );
      }

      // Unexpected errors — the api_error guardrail event catches releases
      // that break a route before users report it.
      console.error(`[API Error] ${request.method} ${request.nextUrl.pathname}:`, error);
      pendingTracks.push(
        trackServer(trackUserId, "api_error", {
          route: request.nextUrl.pathname,
          method: request.method,
        }),
      );
      return jsonResponse(
        { error: "An unexpected error occurred" },
        500,
        headers,
      );
    } finally {
      // Flush analytics + the CAR-68 last-seen stamp on EVERY exit path,
      // including the early returns (auth, admin, rate-limit, validation).
      // finally awaits before the returned response resolves, so nothing is
      // cut off by the serverless freeze.
      await Promise.allSettled(pendingTracks);
    }
  };
}
