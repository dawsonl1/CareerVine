/**
 * Shared auth helper for Chrome extension API routes.
 * Handles both Bearer token auth (extension) and cookie auth (webapp).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { getSupabaseEnv } from "@/lib/supabase/config";
import type { User, SupabaseClient } from "@supabase/supabase-js";

/** CORS headers for Chrome extension requests. */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** Standard OPTIONS handler for extension routes. */
export function handleOptions() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * Authenticate a request from either the Chrome extension (Bearer token)
 * or the webapp (cookies). Returns the Supabase client and authenticated user,
 * or an error response if authentication fails.
 */
export async function getExtensionAuth(request: NextRequest): Promise<
  | { supabase: SupabaseClient; user: User; error?: never }
  | { error: NextResponse; supabase?: never; user?: never }
> {
  const authHeader = request.headers.get("authorization");
  let supabase: SupabaseClient;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const { url, anonKey } = getSupabaseEnv();
    supabase = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  } else {
    supabase = await createSupabaseServerClient();
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (!user || authError) {
    return {
      error: NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      ),
    };
  }

  return { supabase, user };
}
