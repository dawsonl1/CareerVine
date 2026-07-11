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
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { getExtensionAuth, corsHeaders } from "@/lib/extension-auth";
import { checkRateLimit, type RateLimitOptions } from "@/lib/rate-limit";
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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface HandlerContext<TBody = unknown, TQuery = unknown> {
  request: NextRequest;
  user: User;
  supabase: SupabaseClient;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
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

interface RouteConfig<TBody = unknown, TQuery = unknown> {
  /** Zod schema for the JSON request body (POST/PUT/PATCH). */
  schema?: ZodSchema<TBody>;
  /** Zod schema for URL search params. Values arrive as strings. */
  querySchema?: ZodSchema<TQuery>;
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
  /** When true, auth is attempted but handler runs even if user is null. Handler receives user as User | null. */
  authOptional?: boolean;
  /** When true, the authenticated user must carry app_metadata.role === 'admin' or the request is rejected with 403. */
  requireAdmin?: boolean;
  /**
   * Opt-in per-user rate limit (CAR-41), checked right after auth resolves.
   * Skipped when there is no user (authOptional). On exceeded the wrapper
   * returns 429 `{ error, code: 'rate_limited', resetAt }` with Retry-After.
   */
  rateLimit?: RateLimitOptions;
  /** The actual route logic. Return data to send as JSON. */
  handler: (ctx: HandlerContext<TBody, TQuery>) => Promise<unknown>;
}

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

export function withApiHandler<TBody = unknown, TQuery = unknown>(
  config: RouteConfig<TBody, TQuery>,
) {
  return async (
    request: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ) => {
    const headers = config.cors ? corsHeaders : undefined;

    // Analytics captures started during this request; awaited (never thrown)
    // before the response goes out so the lambda doesn't freeze mid-flush.
    const pendingTracks: Promise<void>[] = [];
    let trackUserId: string | null = null;

    try {
      // ── Auth ────────────────────────────────────────────────────
      let user: User;
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
            user = null as unknown as User;
          } else {
            return jsonResponse({ error: "Unauthorized" }, 401, headers);
          }
        } else {
          user = u;
        }
      }

      // ── Admin gate ──────────────────────────────────────────────
      // The admin claim lives in auth.users.app_metadata.role (service-role
      // writable only), so it cannot be spoofed by the client.
      if (config.requireAdmin) {
        const role = (user as User | null)?.app_metadata?.role;
        if (role !== "admin") {
          return jsonResponse({ error: "Forbidden" }, 403, headers);
        }
      }

      // ── Rate limit ──────────────────────────────────────────────
      // Runs before body parse so over-limit requests stay cheap. The 429
      // is returned directly (not thrown as ApiError) because the catch
      // path cannot carry the Retry-After header.
      const rateLimitUserId = (user as User | null)?.id;
      if (config.rateLimit && rateLimitUserId) {
        const rate = await checkRateLimit(rateLimitUserId, config.rateLimit);
        if (!rate.allowed) {
          const retryAfterSec = Math.max(
            1,
            Math.ceil(((rate.resetAt ?? Date.now()) - Date.now()) / 1000),
          );
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
      const params = context?.params ? await context.params : {};

      // ── Body validation ─────────────────────────────────────────
      let body = {} as TBody;
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
      let query = {} as TQuery;
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
      trackUserId = (user as User | null)?.id ?? null;
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
          headers,
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
