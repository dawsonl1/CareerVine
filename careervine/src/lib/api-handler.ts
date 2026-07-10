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
}

interface RouteConfig<TBody = unknown, TQuery = unknown> {
  /** Zod schema for the JSON request body (POST/PUT/PATCH). */
  schema?: ZodSchema<TBody>;
  /** Zod schema for URL search params. Values arrive as strings. */
  querySchema?: ZodSchema<TQuery>;
  /** Use Chrome-extension auth (Bearer token or cookie). */
  extensionAuth?: boolean;
  /** Include CORS headers on the response. */
  cors?: boolean;
  /** When true, auth is attempted but handler runs even if user is null. Handler receives user as User | null. */
  authOptional?: boolean;
  /** When true, the authenticated user must carry app_metadata.role === 'admin' or the request is rejected with 403. */
  requireAdmin?: boolean;
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
      });

      await Promise.allSettled(pendingTracks);

      // Allow handlers to return a NextResponse directly (e.g. redirects)
      if (data instanceof NextResponse) return data;

      return jsonResponse(data, 200, headers);
    } catch (error) {
      // Known API errors thrown intentionally
      if (error instanceof ApiError) {
        await Promise.allSettled(pendingTracks);
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
      await Promise.allSettled(pendingTracks);
      return jsonResponse(
        { error: "An unexpected error occurred" },
        500,
        headers,
      );
    }
  };
}
