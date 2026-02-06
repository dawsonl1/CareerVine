/**
 * Supabase client for server-side admin operations
 * 
 * Uses the base createClient with service role key:
 * - Bypasses Row Level Security (RLS)
 * - Has full database access
 * - Should NEVER be exposed to the browser
 * - Does not use cookies (stateless)
 * 
 * Use this for:
 * - Admin operations that need to bypass RLS
 * - Background jobs/serverless functions
 * - Data migrations or bulk operations
 * 
 * @returns SupabaseClient instance with service role privileges
 */

import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./config";

export const createSupabaseServiceClient = () => {
  const { url, serviceRoleKey } = getSupabaseEnv({ server: true });
  
  if (!serviceRoleKey) {
    throw new Error("Service role key is required for service client");
  }
  
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },  // Stateless - no session persistence
  });
};
