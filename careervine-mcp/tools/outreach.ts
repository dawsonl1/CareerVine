/**
 * Outreach-engine tools (plan 26, tools 15–19). Reuses the app's
 * company-queries data layer directly (service client injected in db.ts)
 * plus the pure plan-25 queue builder.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCompanies, getCompanyDetail, type CompanySummary } from "@/lib/company-queries";
import { buildOutreachQueue, APP_DATE_BOOST_DAYS } from "@/lib/outreach-queue";
import { STAGE_ORDER } from "@/lib/stage-derivation";
import {
  uid,
  db,
  resolveContact,
  resolveCompanyId,
  getOrCreateTargetCompany,
  addTargetCompanyNote,
  setStageOverride,
} from "../lib/db.ts";
import { handler, contactRefShape, companyRefShape } from "../lib/tool-utils.ts";

function compactCompany(c: CompanySummary) {
  return {
    company_id: c.id,
    name: c.name,
    current_count: c.current_count,
    former_count: c.former_count,
    bench_count: c.bench_count,
    traction: c.traction,
    target: c.target
      ? {
          priority_score: c.target.priority_score,
          tier: c.target.tier,
          program_name: c.target.program_name,
          next_app_date: c.target.next_app_date,
          status: c.target.status,
        }
      : null,
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
      const summaries = await getCompanies(uid(), { targetsOnly: true });
      const { queue, skippedCount } = buildOutreachQueue(summaries, new Date().toISOString());
      const today = new Date().toISOString().slice(0, 10);
      const start = offset ?? 0;
      const page = queue.slice(start, start + (limit ?? 25));
      const range = page.length > 0 ? ` showing ${start + 1}–${start + page.length}` : " none on this page";
      return {
        summary: `${queue.length} companies in the queue (${skippedCount} targets skipped — nobody contactable);${range}`,
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
        "Companies in the network with people counts, target status, priority, and traction (furthest outreach stage). Defaults to target companies only.",
      inputSchema: {
        targets_only: z.boolean().optional().describe("Default true; false = every company with contacts"),
        search: z.string().optional().describe("Filter by company name"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ targets_only, search, limit }) => {
      const summaries = await getCompanies(uid(), { targetsOnly: targets_only ?? true, search });
      const page = summaries.slice(0, limit ?? 50);
      return {
        summary: `${summaries.length} companies${page.length < summaries.length ? `; showing first ${page.length} — narrow with search or raise limit` : ""}`,
        companies: page.map(compactCompany),
      };
    }),
  );

  server.registerTool(
    "get_company",
    {
      title: "Get company detail",
      description:
        "Full company picture: who works there now / used to (with roles, emails, stages, alum flags), archived pipeline imports, offices, target status + application dates, and the recruiting-intel note log.",
      inputSchema: companyRefShape,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ company_id, name }) => {
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
        roles: p.roles.map((r) => ({
          title: r.title,
          is_current: r.is_current,
          location: r.location_label,
          workplace_type: r.workplace_type,
        })),
      });

      const CURRENT_CAP = 50, FORMER_CAP = 50, BENCH_CAP = 25;
      const truncated: string[] = [];
      if (detail.current.length > CURRENT_CAP) truncated.push(`current (showing ${CURRENT_CAP} of ${detail.current.length})`);
      if (detail.former.length > FORMER_CAP) truncated.push(`former (showing ${FORMER_CAP} of ${detail.former.length})`);
      if (detail.bench.length > BENCH_CAP) truncated.push(`archived (showing ${BENCH_CAP} of ${detail.bench.length})`);
      return {
        summary:
          `${detail.company.name}: ${detail.current.length} current, ${detail.former.length} former, ${detail.bench.length} archived` +
          (truncated.length ? ` — lists truncated: ${truncated.join(", ")}` : ""),
        company: detail.company,
        target: detail.target,
        offices: detail.offices.map((o) => o.label),
        current: detail.current.slice(0, CURRENT_CAP).map(person),
        former: detail.former.slice(0, FORMER_CAP).map(person),
        archived_imports: detail.bench.slice(0, BENCH_CAP).map(person),
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
      const targetId = await getOrCreateTargetCompany(id);
      await addTargetCompanyNote(targetId, note, location_id ?? null);
      const { data } = await db().from("companies").select("name").eq("id", id).maybeSingle();
      const companyName = (data as { name: string } | null)?.name ?? `company ${id}`;
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
        return { summary: `Cleared stage override for ${contact.name} — back to derived stage` };
      }
      if (!stage) throw new Error("Provide stage, or clear:true to remove the override");
      await setStageOverride(contact.id, stage);
      return { summary: `${contact.name} stage overridden to "${stage}"` };
    }),
  );
}
