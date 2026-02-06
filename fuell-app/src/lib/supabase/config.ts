type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  isLocal: boolean;
};

const isLocalPreferred = () => {
  return (
    process.env.NODE_ENV === "development" &&
    Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL
    )
  );
};

export const getSupabaseEnv = (options?: { server?: boolean }): SupabaseEnv => {
  const useLocal = isLocalPreferred();

  const url = useLocal
    ? process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL
    : process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = useLocal
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = useLocal
    ? process.env.SUPABASE_SERVICE_ROLE_KEY_LOCAL
    : process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables. Check supabase-guide.md for setup instructions."
    );
  }

  if (options?.server && !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY_LOCAL for server-side usage."
    );
  }

  return {
    url,
    anonKey,
    serviceRoleKey,
    isLocal: useLocal,
  };
};
