/**
 * Supabase admin client for privileged operations
 * 
 * This module exports a factory function for creating a Supabase client with
 * service role privileges. The service role key bypasses Row Level Security (RLS)
 * and should only be used on the server for trusted operations.
 * 
 * SECURITY WARNING:
 * - Never expose this client to the browser
 * - Never use this client for user-initiated operations
 * - Only use for trusted server-side operations
 * - This key can read/write ALL data in your database
 */

import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./config";

/**
 * Create a Supabase client with admin privileges
 * 
 * Uses the service role key which:
 * - Bypasses all Row Level Security (RLS) policies
 * - Has full read/write access to all tables
 * - Can manage users and auth settings
 * - Should ONLY be used on the server
 * 
 * Common use cases:
 * - Admin dashboard operations
 * - Bulk data imports/exports
 * - User management (admin functions)
 * - Background jobs that need full access
 * - Database migrations (programmatic)
 * 
 * @returns SupabaseClient instance with service role privileges
 * @throws Error if service role key is not configured
 */
export const supabaseAdmin = () => {
  // Get environment configuration including service role key
  const { url, serviceRoleKey } = getSupabaseEnv({ server: true });
  
  // Validate that service role key is available
  if (!serviceRoleKey) {
    throw new Error("Service role key is required for admin client");
  }
  
  // Create client with service role key
  // auth.persistSession: false makes it stateless (no cookies/storage)
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
};
