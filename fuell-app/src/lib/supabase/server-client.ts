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

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./config";

export const createSupabaseServerClient = async () => {
  const { url, anonKey } = getSupabaseEnv({ server: true });
  const cookieStore = await cookies();
  
  return createServerClient(url, anonKey, {
    cookies: {
      // Read all cookies from the request
      getAll: () => cookieStore.getAll(),
      // Write cookies back to the response
      setAll: (cookiesToSet: { name: string; value: string }[]) => {
        cookiesToSet.forEach(({ name, value }) => cookieStore.set(name, value));
      },
    },
  });
};
