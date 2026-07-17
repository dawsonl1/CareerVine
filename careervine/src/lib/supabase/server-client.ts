/**
 * Supabase client for server-side usage
 * 
 * Uses the SSR package with Next.js cookies integration:
 * - Reads auth state from request cookies
 * - Can write auth state changes back to response cookies
 * - Maintains auth state between server and client
 * 
 * Use this in:
 * - Server Components (default in Next.js App Router)
 * - Route Handlers (API routes)
 * - Server Actions
 * 
 * @returns Promise<SupabaseClient> instance configured for server
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./config";
import type { Database } from "../database.types";

export const createSupabaseServerClient = async () => {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      // Read all cookies from the request
      getAll: () => cookieStore.getAll(),
      // Write cookies back to the response — options must pass through, or
      // fresh sessions (e.g. /auth/confirm's verifyOtp) lose maxAge/path and
      // degrade to browser-session cookies.
      setAll: (cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where the cookie store is
          // read-only. Safe to ignore: src/proxy.ts refreshes sessions and
          // persists rotated cookies before the render ever runs.
        }
      },
    },
  });
};
