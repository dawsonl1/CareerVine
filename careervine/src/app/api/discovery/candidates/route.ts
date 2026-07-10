import { withApiHandler } from "@/lib/api-handler";

/**
 * GET /api/discovery/candidates[?company_id=123]
 * The session user's NEW discovery candidates (plan 41), company info
 * attached. The home digest groups them client-side; the company page
 * filters by company_id. RLS (select-own) scopes the read.
 */
export const GET = withApiHandler({
  handler: async ({ user, supabase, request }) => {
    const companyIdParam = request.nextUrl.searchParams.get("company_id");
    const companyId = companyIdParam != null ? Number(companyIdParam) : null;

    let query = supabase
      .from("discovery_candidates")
      .select(
        "id, company_id, linkedin_url, name, headline, location, photo_url, position, first_seen_at, last_seen_at, companies(id, name, logo_url)",
      )
      .eq("user_id", user.id)
      .eq("status", "new")
      .order("last_seen_at", { ascending: false });
    if (companyId != null && Number.isFinite(companyId)) {
      query = query.eq("company_id", companyId);
    }

    const { data, error } = await query;
    if (error) throw new Error(`candidate fetch failed: ${error.message}`);
    return { candidates: data ?? [] };
  },
});
