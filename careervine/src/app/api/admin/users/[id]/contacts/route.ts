import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { writeAudit } from "@/lib/admin";
import { processSubscriptionsUnderBudget } from "@/lib/bundle-queue";

const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "prospect", "bench"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PAGE_SIZE = 100;
/** Cap on company-name matches folded into the OR filter — keeps the
 *  PostgREST `id.in.(…)` list bounded on huge accounts. */
const COMPANY_MATCH_CAP = 500;

type AdminContactRow = {
  id: number;
  name: string;
  linkedin_url: string | null;
  network_status: string;
  created_at: string;
  contact_emails: Array<{ email: string | null; is_primary: boolean }>;
  contact_companies: Array<{
    title: string | null;
    is_current: boolean;
    start_date: string | null;
    // PostgREST returns an object for this to-one embed, but the generated
    // types disagree — accept both shapes.
    companies: { name: string } | Array<{ name: string }> | null;
  }>;
};

function companyName(
  companies: { name: string } | Array<{ name: string }> | null,
): string | null {
  if (!companies) return null;
  return Array.isArray(companies) ? (companies[0]?.name ?? null) : companies.name;
}

/**
 * GET /api/admin/users/[id]/contacts — the target account's contacts.
 *
 * `q` matches contact name OR a company the contact has worked at;
 * `status` filters by network tier; `offset` pages (100/page). Returns
 * `total` (exact count under the current filters) so the UI can show
 * "X of Y" instead of silently truncating.
 */
export const GET = withApiHandler<
  unknown,
  { q?: string; status?: "active" | "prospect" | "bench"; offset?: number }
>({
  requireAdmin: true,
  querySchema,
  handler: async ({ params, query }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();
    const offset = query.offset ?? 0;

    const q = (query.q ?? "").replace(/[,()%*]/g, " ").trim();

    // PostgREST can't OR a top-level filter with an embedded-resource one,
    // so resolve company-name matches to contact ids first.
    let companyMatchIds: number[] = [];
    if (q) {
      const { data: matches, error: matchError } = await service
        .from("contact_companies")
        .select("contact_id, companies!inner(name), contacts!inner(user_id)")
        .eq("contacts.user_id", id)
        .ilike("companies.name", `%${q}%`)
        .limit(COMPANY_MATCH_CAP);
      if (matchError) throw new Error(matchError.message);
      companyMatchIds = [
        ...new Set(
          ((matches as Array<{ contact_id: number }>) ?? []).map((m) => m.contact_id),
        ),
      ];
    }

    let contactsQuery = service
      .from("contacts")
      .select(
        "id, name, linkedin_url, network_status, created_at, contact_emails(email, is_primary), contact_companies(title, is_current, start_date, companies(name))",
        { count: "exact" },
      )
      .eq("user_id", id);

    if (query.status) contactsQuery = contactsQuery.eq("network_status", query.status);
    if (q) {
      contactsQuery = companyMatchIds.length
        ? contactsQuery.or(`name.ilike.%${q}%,id.in.(${companyMatchIds.join(",")})`)
        : contactsQuery.ilike("name", `%${q}%`);
    }

    const { data, error, count } = await contactsQuery
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    const contacts = ((data as unknown as AdminContactRow[]) ?? []).map((c) => {
      const role =
        c.contact_companies.find((cc) => cc.is_current) ??
        [...c.contact_companies].sort((a, b) =>
          (b.start_date ?? "").localeCompare(a.start_date ?? ""),
        )[0] ??
        null;
      return {
        id: c.id,
        name: c.name,
        linkedinUrl: c.linkedin_url,
        networkStatus: c.network_status,
        createdAt: c.created_at,
        email:
          c.contact_emails.find((e) => e.is_primary)?.email ??
          c.contact_emails[0]?.email ??
          null,
        title: role?.title ?? null,
        company: companyName(role?.companies ?? null),
      };
    });

    return { contacts, total: count ?? contacts.length };
  },
});

const postSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("manual"),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().optional(),
    linkedin_url: z.string().trim().url().optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
  z.object({
    mode: z.literal("bundle"),
    bundleId: z.number().int().positive(),
  }),
]);

/**
 * POST /api/admin/users/[id]/contacts — inject contacts into an account.
 *
 * 'manual' inserts one contact (with optional primary email) as the target
 * user. 'bundle' grants the bundle (visibility override), subscribes the
 * account, and applies as much of the import as fits this request's budget —
 * the bundle-sync cron finishes any remainder, same as a self-subscribe.
 */
export const POST = withApiHandler<z.infer<typeof postSchema>>({
  requireAdmin: true,
  schema: postSchema,
  handler: async ({ user: admin, body, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    const { data: target } = await service
      .from("users")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!target) throw new ApiError("User not found", 404);

    if (body.mode === "manual") {
      const { data: contact, error } = await service
        .from("contacts")
        .insert({
          user_id: id,
          name: body.name,
          linkedin_url: body.linkedin_url ?? null,
          notes: body.notes ?? null,
        })
        .select("id, name")
        .single();
      if (error) throw new ApiError(`Couldn't add contact: ${error.message}`, 400);

      if (body.email) {
        const { error: emailError } = await service.from("contact_emails").insert({
          contact_id: (contact as { id: number }).id,
          email: body.email,
          is_primary: true,
        });
        if (emailError) {
          throw new ApiError(
            `Contact created but email failed: ${emailError.message}`,
            400,
          );
        }
      }

      await writeAudit(service, {
        adminId: admin.id,
        targetUserId: id,
        action: "inject_contact",
        detail: { contactId: (contact as { id: number }).id, name: body.name },
      });

      return { contact };
    }

    // mode 'bundle'
    const { data: bundle } = await service
      .from("data_bundles")
      .select("id, name, prospect_count, status")
      .eq("id", body.bundleId)
      .maybeSingle();
    if (!bundle || (bundle as { status: string }).status !== "published") {
      throw new ApiError("Bundle not found or not published", 404);
    }

    // Injecting implies access: grant the visibility override so the user can
    // see (and manage) the subscription they now have.
    await service.from("bundle_access_overrides").upsert({
      user_id: id,
      bundle_id: body.bundleId,
      allowed: true,
      updated_by: admin.id,
      updated_at: new Date().toISOString(),
    });

    // Subscribe (or reactivate) on their behalf — same shape as the user
    // subscribe route, but via the service client.
    const { data: existing } = await service
      .from("bundle_subscriptions")
      .select("id, status")
      .eq("user_id", id)
      .eq("bundle_id", body.bundleId)
      .maybeSingle();

    let subscriptionId: number;
    if (existing) {
      subscriptionId = (existing as { id: number }).id;
      if ((existing as { status: string }).status !== "active") {
        const { error } = await service
          .from("bundle_subscriptions")
          .update({
            status: "active",
            synced_version: 0,
            sync_claimed_until: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", subscriptionId);
        if (error) throw new ApiError(`Subscribe failed: ${error.message}`, 400);
      }
    } else {
      const { data: created, error } = await service
        .from("bundle_subscriptions")
        .insert({ user_id: id, bundle_id: body.bundleId })
        .select("id")
        .single();
      if (error) throw new ApiError(`Subscribe failed: ${error.message}`, 400);
      subscriptionId = (created as { id: number }).id;
    }

    // Apply what fits in this request; the sync cron finishes the rest.
    const result = await processSubscriptionsUnderBudget(service, [subscriptionId]);

    await writeAudit(service, {
      adminId: admin.id,
      targetUserId: id,
      action: "inject_bundle",
      detail: {
        bundleId: body.bundleId,
        bundleName: (bundle as { name: string }).name,
        applied: result.applied,
        completed: result.completed.length > 0,
      },
    });

    return {
      subscriptionId,
      applied: result.applied,
      completed: result.completed.length > 0,
      prospectCount: (bundle as { prospect_count: number }).prospect_count,
    };
  },
});
