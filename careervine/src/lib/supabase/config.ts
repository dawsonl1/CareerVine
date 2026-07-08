/**
 * Supabase configuration — auto-switches between local and production
 *
 * Local development (NODE_ENV === "development"):
 *   Uses _LOCAL env vars → connects to the local Supabase stack (127.0.0.1).
 *
 * Production / Vercel (NODE_ENV === "production"):
 *   Uses standard env vars → connects to your hosted Supabase project.
 *
 * On Vercel, set these environment variables in the project settings:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Override: set NEXT_PUBLIC_SUPABASE_USE_PROD=true in .env.local to make
 * `next dev` connect to the production Supabase project instead of the
 * local stack (useful for viewing real data during UI work).
 */

type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  isLocal: boolean;
};

export const getSupabaseEnv = (options?: { server?: boolean }): SupabaseEnv => {
  const forceProd = process.env.NEXT_PUBLIC_SUPABASE_USE_PROD === "true";
  const isLocal = process.env.NODE_ENV === "development" && !forceProd;

  const url = isLocal
    ? process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL
    : process.env.NEXT_PUBLIC_SUPABASE_URL;

  const anonKey = isLocal
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const serviceRoleKey = isLocal
    ? process.env.SUPABASE_SERVICE_ROLE_KEY_LOCAL
    : process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey) {
    throw new Error(
      isLocal
        ? "Missing local Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL_LOCAL and NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL in .env.local"
        : "Missing production Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your Vercel project settings."
    );
  }

  if (options?.server && !serviceRoleKey) {
    throw new Error(
      isLocal
        ? "Missing SUPABASE_SERVICE_ROLE_KEY_LOCAL for server-side usage."
        : "Missing SUPABASE_SERVICE_ROLE_KEY in your Vercel project settings."
    );
  }

  return { url, anonKey, serviceRoleKey, isLocal };
};
