/**
 * Outreach-engine tools (plan 26, tools 15–19). Reuses the app's
 * company-queries data layer directly (service client injected in db.ts)
 * plus the pure plan-25 queue builder.
 */

import { z } from "zod";
import { addPipelineNote } from "@/lib/data/pipeline";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCompanies, getCompanyDetail, type CompanySummary, type CompanyBaseSummary } from "@/lib/company-queries";
import { buildOutreachQueue, APP_DATE_BOOST_DAYS } from "@/lib/outreach-queue";
import { STAGE_ORDER } from "@/lib/stage-derivation";
import {
  uid,
  resolveContact,
  resolveCompanyId,
  getOrCreateTargetCompany,
  getCompanyName,
  setStageOverride,
} from "../lib/db";
import { handler, contactRefShape, companyRefShape } from "../lib/tool-utils";

/**
 * " showing 51-75 of 300" — the phrase every paged tool here appends.
 *
 * Always states the window when there is more than one page, because a bare
 * count with a silently truncated list is how an agent concludes it has seen
 * everything (CAR-262).
 */
function pageNote(total: number, start: number, shown: number): string {
  if (shown === 0) return total === 0 ? "" : ` — none on this page (offset ${start} of ${total})`;
  if (shown === total && start === 0) return "";
  return `; showing ${start + 1}-${start + shown}${start + shown < total ? ` (pass offset:${start + shown} for more)` : ""}`;
}

/**
 * The company row every list tool returns.
 *
 * Split in two by whether the who-you-know pass ran (CAR-262). The base half is
 * always real; the enriched half is present ONLY when it was actually computed,
 * because emitting `traction: null` for a scope that never computed it told
 * agents "nobody has been contacted here" about companies with live threads.
 */
function compactCompanyBase(c: CompanyBaseSummary) {
  return {
    company_id: c.id,
    name: c.name,
    linkedin_url: c.linkedin_url,
    current_count: c.current_count,
    former_count: c.former_count,
    bench_count: c.bench_count,
    target: c.target
      ? {
          target_id: c.target.id,
          priority_score: c.target.priority_score,
          program_name: c.target.program_name,
          next_app_date: c.target.next_app_date,
          app_window_text: c.target.app_window_text,
          status: c.target.status,
        }
      : null,
  };
}

function compactCompany(c: CompanySummary) {
  return {
    ...compactCompanyBase(c),
    // `traction` alone answers "how far did we get"; `traction_detail` answers
    // "how many, and how long ago" — the difference between "call_done" and
    // "2 calls done, 3 weeks ago", which is what decides whether to follow up.
    traction: c.traction,
    traction_detail: c.traction_detail,
    alum_count: c.alum_count,
    product_alum_count: c.product_alum_count,
    recruiter_count: c.recruiter_count,
    lead_contact_name: c.lead_contact_name,
  };
}

export function registerOutreachTools(server: McpServer): void {
  server.registerTool(
    "list_outreach_queue",
    {
      title: "List outreach queue",
      description:
        "The company-by-company outreach queue: target companies with at least one contactable person, ordered by application deadline (within the boost window) then priority. Use get_company on a queue entry to see who to contact, then get_contact_dossier + create_email_draft to work them.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max queue entries to return (default 25)"),
        offset: z.number().int().min(0).optional().describe("Skip this many entries (for paging deeper)"),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ limit, offset }) => {
      const summaries = await getCompanies(uid(), { scope: "targets" });
      const { queue, skippedCount } = buildOutreachQueue(summaries, new Date().toISOString());
      const today = new Date().toISOString().slice(0, 10);
      const start = offset ?? 0;
      const page = queue.slice(start, start + (limit ?? 25));
      const range = page.length > 0 ? ` showing ${start + 1}–${start + page.length}` : " none on this page";
      return {
        summary: `${queue.length} companies in the queue (${skippedCount} targets skipped: nobody contactable);${range}`,
        boost_window_days: APP_DATE_BOOST_DAYS,
        queue: page.map((c, i) => ({
          position: start + i + 1,
          ...compactCompany(c),
          why:
            c.target?.next_app_date && c.target.next_app_date >= today
              ? `application date ${c.target.next_app_date}`
              : c.target?.priority_score != null
                ? `priority ${c.target.priority_score}`
                : "target company",
        })),
      };
    }),
  );

  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description:
        "Companies in the network with people counts, target status, priority, and traction (furthest outreach stage). Defaults to target companies only. Traction and alumni counts are returned ONLY for targets_only:true — the all-companies scope is too large to compute them over, and those keys are omitted rather than sent as zero. Use get_company for real traction on one company.",
      inputSchema: {
        targets_only: z.boolean().optional().describe("Default true; false = every company with contacts (omits traction/alumni fields)"),
        search: z.string().optional().describe("Filter by company name"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
        offset: z.number().int().min(0).optional().describe("Skip this many companies (for paging deeper)"),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ targets_only, search, limit, offset }) => {
      const start = offset ?? 0;
      const size = limit ?? 50;

      // Two branches rather than one ternary scope, because the two calls now
      // return DIFFERENT SHAPES (CAR-262) and that is the whole point: the "all"
      // scope cannot afford the who-you-know pass, so its rows must not carry
      // fields that would read as measured zeroes. TypeScript picks the matching
      // overload per branch and `compactCompany` is unavailable on the base row.
      if (targets_only === false) {
        const summaries = await getCompanies(uid(), {
          scope: "all",
          search,
          enrich: false,
          sort: "name",
        });
        const page = summaries.slice(start, start + size);
        return {
          summary:
            `${summaries.length} companies${pageNote(summaries.length, start, page.length)}. ` +
            "Traction and alumni counts are NOT included for this scope (not computed, not zero) — " +
            "call with targets_only:true, or get_company for one company.",
          traction_included: false,
          companies: page.map(compactCompanyBase),
        };
      }

      const summaries = await getCompanies(uid(), { scope: "targets", search });
      const page = summaries.slice(start, start + size);
      return {
        summary: `${summaries.length} target companies${pageNote(summaries.length, start, page.length)}`,
        traction_included: true,
        companies: page.map(compactCompany),
      };
    }),
  );

  server.registerTool(
    "get_company",
    {
      title: "Get company detail",
      description:
        "Full company picture: who works there now / used to (with roles, emails, stages, alum flags, adjacency score and why each person was kept), archived pipeline imports, offices with their location ids, target status + application dates, and the recruiting-intel note log. Rosters page with limit/offset, and `group` narrows to one of current/former/archived.",
      inputSchema: {
        ...companyRefShape,
        group: z
          .enum(["current", "former", "archived", "all"])
          .optional()
          .describe("Which roster to return (default all). Narrow before paging a large company."),
        limit: z.number().int().min(1).max(200).optional().describe("Max people per roster (default 50)"),
        offset: z.number().int().min(0).optional().describe("Skip this many people in each roster returned"),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ company_id, name, group, limit, offset }) => {
      const id = await resolveCompanyId({ company_id, name });
      const detail = await getCompanyDetail(uid(), id);
      if (!detail) throw new Error(`No company with id ${id}`);

      const person = (p: (typeof detail.current)[number]) => ({
        contact_id: p.contact_id,
        name: p.name,
        headline: p.headline,
        persona: p.persona,
        network_tier: p.network_status,
        is_alum: p.is_alum,
        stage: p.stage,
        email: p.email,
        review_note: p.review_note,
        linkedin_url: p.linkedin_url,
        // Why the pipeline kept this person, and how close they sit to the
        // target role. Both were computed and then dropped before CAR-262, which
        // left an agent ranking a roster with no signal to rank it by.
        selection_reason: p.selection_reason,
        adjacency_score: p.adjacency_score,
        last_interaction: p.last_interaction,
        last_scraped_at: p.last_scraped_at,
        // Where they work NOW, which for a `former` entry is the whole point:
        // it is the difference between a dead lead and a warm one somewhere new.
        current_position: p.current_position,
        roles: p.roles.map((r) => ({
          title: r.title,
          is_current: r.is_current,
          start_month: r.start_month,
          end_month: r.end_month,
          location: r.location_label,
          location_id: r.location_id,
          workplace_type: r.workplace_type,
        })),
      });

      // Paged, not capped (CAR-262). The old hard caps of 50/50/25 had no offset,
      // so person #51 at a large company was permanently unreachable through the
      // MCP: the summary announced the truncation and offered no way past it.
      const start = offset ?? 0;
      const size = limit ?? 50;
      const want = group ?? "all";
      const slice = (rows: typeof detail.current) => rows.slice(start, start + size);
      const rosters = {
        current: want === "all" || want === "current" ? slice(detail.current) : [],
        former: want === "all" || want === "former" ? slice(detail.former) : [],
        archived: want === "all" || want === "archived" ? slice(detail.bench) : [],
      };
      const notes = [
        want === "all" || want === "current" ? `current${pageNote(detail.current.length, start, rosters.current.length)}` : null,
        want === "all" || want === "former" ? `former${pageNote(detail.former.length, start, rosters.former.length)}` : null,
        want === "all" || want === "archived" ? `archived${pageNote(detail.bench.length, start, rosters.archived.length)}` : null,
      ].filter(Boolean);

      return {
        summary:
          `${detail.company.name}: ${detail.current.length} current, ${detail.former.length} former, ${detail.bench.length} archived` +
          (want === "all" ? "" : ` (showing ${want} only)`) +
          `. Rosters: ${notes.join("; ")}`,
        company: detail.company,
        target: detail.target,
        // Objects, not bare labels (CAR-262): `add_company_intel` takes a
        // `location_id` parameter that no tool used to hand out, so tagging a
        // note to an office was impossible through the MCP.
        offices: detail.offices.map((o) => ({
          location_id: o.location_id,
          label: o.label,
          city: o.city,
          state: o.state,
          country: o.country,
          source: o.source,
        })),
        // Headcount per office, including the Remote and Unknown buckets. Already
        // computed by getCompanyDetail and previously discarded whole.
        office_facets: detail.facets,
        current: rosters.current.map(person),
        former: rosters.former.map(person),
        archived_imports: rosters.archived.map(person),
        counts: {
          current: detail.current.length,
          former: detail.former.length,
          archived: detail.bench.length,
        },
      };
    }),
  );

  server.registerTool(
    "add_company_intel",
    {
      title: "Add company intel",
      description:
        "Append a timestamped note to a company's recruiting-intel log (application windows, referral programs, team info). The company becomes a target automatically if it isn't one yet.",
      inputSchema: {
        ...companyRefShape,
        note: z.string().min(1),
        location_id: z.number().int().optional().describe("Optional office location id to tag the note with"),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ company_id, name, note, location_id }) => {
      const id = await resolveCompanyId({ company_id, name });
      // CAR-238: write the same pipeline note the company page's "Add note"
      // creates, so it lands in the visible Notes list instead of a fallback
      // block the first user-typed note hides forever.
      const targetId = await getOrCreateTargetCompany(id, location_id ?? null);
      await addPipelineNote(uid(), targetId, note);
      const companyName = (await getCompanyName(id)) ?? `company ${id}`;
      return { summary: `Intel logged for ${companyName}` };
    }),
  );

  server.registerTool(
    "set_stage_override",
    {
      title: "Set outreach stage override",
      description:
        "Manually override a contact's derived outreach stage — for outreach that happened off-platform (e.g. LinkedIn DMs). Pass clear:true to remove the override and return to derived stages.",
      inputSchema: {
        ...contactRefShape,
        stage: z.enum(STAGE_ORDER as [string, ...string[]]).optional(),
        clear: z.boolean().optional().describe("true removes the override"),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, stage, clear }) => {
      const contact = await resolveContact({ contact_id, name });
      if (clear) {
        await setStageOverride(contact.id, null);
        return { summary: `Cleared stage override for ${contact.name}, back to derived stage` };
      }
      if (!stage) throw new Error("Provide stage, or clear:true to remove the override");
      await setStageOverride(contact.id, stage);
      return { summary: `${contact.name} stage overridden to "${stage}"` };
    }),
  );
}
