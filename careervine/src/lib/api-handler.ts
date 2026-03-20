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
import type { SupabaseClient, User } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number = 400,
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
      const data = await config.handler({
        request,
        user,
        supabase,
        body,
        query,
        params,
      });

      // Allow handlers to return a NextResponse directly (e.g. redirects)
      if (data instanceof NextResponse) return data;

      return jsonResponse(data, 200, headers);
    } catch (error) {
      // Known API errors thrown intentionally
      if (error instanceof ApiError) {
        return jsonResponse({ error: error.message }, error.status, headers);
      }

      // Unexpected errors
      console.error(`[API Error] ${request.method} ${request.nextUrl.pathname}:`, error);
      return jsonResponse(
        { error: "An unexpected error occurred" },
        500,
        headers,
      );
    }
  };
}
