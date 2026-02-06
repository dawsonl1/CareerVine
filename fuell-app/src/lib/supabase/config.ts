/**
 * Supabase configuration for dev-only environment
 * 
 * This file handles environment variable resolution for connecting to your local Supabase instance.
 * In production, you'd want to expand this to support both local and remote environments.
 */

// Type definition for our Supabase environment configuration
// Provides type safety and documentation for all required config values
type SupabaseEnv = {
  url: string;                 // Supabase project URL
  anonKey: string;             // Public anonymous key (safe to expose to browser)
  serviceRoleKey?: string;     // Service role key (server-only, bypasses RLS)
  isLocal: boolean;            // Flag indicating if using local Supabase
};

/**
 * Get Supabase environment configuration
 * 
 * For dev-only setup, this only looks for local environment variables with the _LOCAL suffix.
 * This prevents accidentally using production credentials during development.
 * 
 * @param options - Configuration options
 * @param options.server - Whether this is being called from server-side code
 * @returns SupabaseEnv object with connection details
 * @throws Error if required environment variables are missing
 */
export const getSupabaseEnv = (options?: { server?: boolean }): SupabaseEnv => {
  // Only look for local environment variables (dev-only setup)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY_LOCAL;

  // Validate required public variables (needed for both client and server)
  if (!url || !anonKey) {
    throw new Error(
      "Missing local Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL_LOCAL and NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL in .env.local"
    );
  }

  // For server-side operations, we also need the service role key
  // This key bypasses Row Level Security (RLS) and should only be used on the server
  if (options?.server && !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY_LOCAL for server-side usage."
    );
  }

  // Return configuration object
  return {
    url,
    anonKey,
    serviceRoleKey,
    isLocal: true,  // Always true for dev-only setup
  };
};
