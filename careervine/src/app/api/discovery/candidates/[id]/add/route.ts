import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { importPeopleChunk } from "@/lib/bulk-import";
import { buildCandidatePeopleRecord } from "@/lib/apify/discovery";
import { triggerEnrichOnSave } from "@/lib/apify/scrape-service";

/**
 * POST /api/discovery/candidates/[id]/add
 * Convert a discovery candidate into a prospect contact (plan 41 §5.3):
 * schema-v1 record → importPeopleChunk (company identity threaded so the
 * existing company row is matched, not duplicated) → candidate marked
 * 'added' → auto-enrich (respects the admin enrichment switch + caps;
 * never throws).
 */
export const maxDuration = 30;

export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const candidateId = Number(params.id);
    if (!Number.isFinite(candidateId)) throw new ApiError("Invalid candidate id", 400);

    const service = createSupabaseServiceClient();
    const { data: candidate } = await service
      .from("discovery_candidates")
      .select("id, company_id, linkedin_url, name, headline, location, photo_url, position, raw, status")
      .eq("id", candidateId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!candidate) throw new ApiError("Candidate not found", 404);

    const c = candidate as {
      id: number;
      company_id: number;
      linkedin_url: string;
      name: string;
      headline: string | null;
      location: string | null;
      photo_url: string | null;
      position: string | null;
      raw: unknown;
      status: string;
    };
    if (c.status !== "new") {
      throw new ApiError(c.status === "added" ? "Already added" : "Candidate was dismissed", 409);
    }

    const { data: company } = await service
      .from("companies")
      .select("name, linkedin_url, linkedin_company_id")
      .eq("id", c.company_id)
      .maybeSingle();
    if (!company) throw new ApiError("Company not found", 404);

    const record = buildCandidatePeopleRecord(
      c,
      company as { name: string; linkedin_url: string | null; linkedin_company_id: string | null },
    );
    const summary = await importPeopleChunk(service, user.id, [{ record }], {
      analyticsSource: "discovery",
    });
    const result = summary.results[0];

    if (result?.status === "skipped_suppressed") {
      // A previously deleted import — honor the tombstone and stop resurfacing.
      await service.from("discovery_candidates").update({ status: "dismissed" }).eq("id", c.id);
      throw new ApiError("This person was previously deleted from your contacts", 409);
    }
    if (!result || result.status === "error" || result.contact_id == null) {
      throw new ApiError(result?.error ?? "Could not create the contact", 500);
    }

    await service
      .from("discovery_candidates")
      .update({ status: "added", added_contact_id: result.contact_id })
      .eq("id", c.id);

    const enrich = await triggerEnrichOnSave(user.id, result.contact_id);
    return { success: true, contactId: result.contact_id, enrich: enrich.status };
  },
});
