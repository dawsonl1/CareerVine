/**
 * Supabase client for browser-side usage
 * 
 * Uses the SSR package which automatically handles:
 * - JWT token storage in cookies
 * - Token refresh
 * - Auth state persistence across page reloads
 * 
 * Use this in client components ("use client") for authenticated operations
 * 
 * @returns SupabaseClient instance configured for browser
 */

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./config";
import type { Database } from "../database.types";

export const createSupabaseBrowserClient = () => {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient<Database>(url, anonKey);
};
