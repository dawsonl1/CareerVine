/**
 * POST /api/target-companies/bulk-import — target-company list import
 * (plan 24 §2g). Loads the ~337-company APM sheet before people arrive.
 *
 * Re-runnable: research fields (priority_score, tier, program_name,
 * app_window_text) refresh from the sheet; hand-set fields
 * (next_app_date, status, is_targeted) are never touched on re-import.
 *
 * `is_targeted` joined that list in CAR-258. It used to be forced back to true
 * on every existing row, so re-running the sheet silently undid a company the
 * user had untargeted by hand — the one thing a re-import must not do, since the
 * only two writers of `is_targeted = false` in the codebase are both user
 * actions (the company page's "Not a target" picker, and removing an office).
 */

import { withApiHandler } from "@/lib/api-handler";
import { targetCompaniesBulkImportSchema } from "@/lib/api-schemas";
import { handleOptions } from "@/lib/extension-auth";
import { findOrCreateCompany } from "@/lib/company-helpers";

export const maxDuration = 60;

interface TargetCompanyInput {
  name: string;
  linkedin_url?: string | null;
  linkedin_company_id?: string | null;
  universal_name?: string | null;
  priority_score?: number | null;
  tier?: string | null;
  program_name?: string | null;
  app_window_text?: string | null;
}

export async function OPTIONS() {
  return handleOptions();
}

export const POST = withApiHandler({
  schema: targetCompaniesBulkImportSchema,
  extensionAuth: true,
  stampExtensionSeen: false, // ops-script/web-driven — a bulk run is not an "extension connected" signal (CAR-68)
  cors: true,
  handler: async ({ supabase, user, body, track }) => {
    const { companies } = body as { companies: TargetCompanyInput[] };

    let created = 0;
    let updated = 0;
    const errors: Array<{ name: string; error: string }> = [];
    // Identity-less rows whose name resembles an existing company — the
    // split-row pattern CAR-44 cleaned up. Import succeeds; caller decides.
    const warnings: Array<{ name: string; possible_duplicate_of: string }> = [];

    for (const input of companies) {
      try {
        const company = await findOrCreateCompany(supabase, {
          name: input.name,
          linkedin_url: input.linkedin_url,
          linkedin_company_id: input.linkedin_company_id,
          universal_name: input.universal_name,
        });
        if (company.possible_duplicate_of) {
          warnings.push({ name: company.name, possible_duplicate_of: company.possible_duplicate_of.name });
          track("company_duplicate_suspected", {
            company: company.name,
            possible_duplicate: company.possible_duplicate_of.name,
          });
        }

        const researchFields = {
          priority_score: input.priority_score ?? null,
          tier: input.tier?.trim() || null,
          program_name: input.program_name?.trim() || null,
          app_window_text: input.app_window_text?.trim() || null,
        };

        const { data: existing } = await supabase
          .from("target_companies")
          .select("id")
          .eq("user_id", user.id)
          .eq("company_id", company.id)
          .is("location_id", null)
          .maybeSingle();

        if (existing) {
          // Research fields only — `is_targeted` is deliberately absent (CAR-258).
          //
          // The residual case this accepts: a row can also sit at false because
          // pipeline autosave created it as an untargeted CONTAINER (research
          // notes on a company that was never targeted), and such a row now stays
          // untargeted even though being on the sheet argues for targeting it.
          // Distinguishing the two would take a column recording explicit intent,
          // and it is not worth one — the sheet loads before people arrive, so a
          // sheet company already has a targeted row from the first run, and the
          // only way it reaches false afterwards is the user untargeting it.
          const { error } = await supabase
            .from("target_companies")
            .update({ ...researchFields, updated_at: new Date().toISOString() })
            .eq("id", (existing as { id: number }).id);
          if (error) throw error;
          updated++;
        } else {
          const { error } = await supabase.from("target_companies").insert({
            user_id: user.id,
            company_id: company.id,
            ...researchFields,
          });
          if (error) throw error;
          created++;
        }
      } catch (err) {
        // Curate at the client boundary (CAR-149 F45): any raw error in the loop
        // — a DB error above, or a raw supabase error thrown by
        // findOrCreateCompany — stays in the server log; the caller only ever
        // gets a safe per-company message, never a raw error.message.
        console.error(`[target-companies/bulk-import] import failed for "${input.name}":`, err);
        errors.push({ name: input.name, error: "Could not import this company." });
      }
    }

    return { created, updated, errors, warnings };
  },
});
