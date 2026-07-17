/**
 * Shared Supabase client seam for the src/lib/data query modules (CAR-146).
 *
 * The client is resolved lazily so these modules can run outside the
 * browser: a server or MCP context injects its own client via
 * setDataClient() (all queries are user-scoped, mirroring the
 * company-queries seam); the app falls back to the usual browser
 * singleton on first use. Nothing is created at import time.
 */

import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export type QueryClient = ReturnType<typeof createSupabaseBrowserClient>;

let injectedClient: QueryClient | null = null;
let browserClient: QueryClient | null = null;

/** Inject a client (server route, MCP, tests). Pass null to restore the browser fallback. */
export function setDataClient(client: QueryClient | null) {
  injectedClient = client;
}

export function db(): QueryClient {
  if (injectedClient) return injectedClient;
  if (!browserClient) browserClient = createSupabaseBrowserClient();
  return browserClient;
}

/**
 * Unwrap a PostgREST response, throwing its error (the must() read
 * convention, CAR-146): control-flow-bearing reads — cursors, dedup
 * checks, claim preconditions — must not silently continue on a failed
 * query. Purely-cosmetic reads may keep empty-on-error, but only with an
 * explicit `// error-tolerated:` annotation at the call site.
 *
 * Works on any awaited builder: for `.maybeSingle()` T unifies to
 * `Row | null` (a missing row is still expressible), for bare mutations
 * T is null.
 */
export function must<T>(res: PostgrestSingleResponse<T>): T {
  if (res.error) throw res.error;
  return res.data;
}
