/**
 * Per-account Apify controls (plan 36 / CAR-25): admin-owned kill switches
 * read at every spend/diff choke point. Fail CLOSED — an error reading the
 * flags must never let a paid run start (same posture as the spend cap).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export interface ApifyAccountControls {
  enrichmentEnabled: boolean;
  diffEnabled: boolean;
}

export async function getApifyControls(
  service: ServiceClient,
  userId: string,
): Promise<ApifyAccountControls> {
  const { data, error } = await service
    .from("users")
    .select("apify_enrichment_enabled, diff_analysis_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error(`[apify controls] read failed for ${userId}: ${error.message}`);
    return { enrichmentEnabled: false, diffEnabled: false };
  }
  const row = data as { apify_enrichment_enabled: boolean; diff_analysis_enabled: boolean };
  return {
    enrichmentEnabled: row.apify_enrichment_enabled,
    diffEnabled: row.diff_analysis_enabled,
  };
}
