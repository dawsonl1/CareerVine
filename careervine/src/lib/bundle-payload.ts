/**
 * Bundle payload contract (plan 29 §1).
 *
 * `BundleProspectPayloadV1` is the CareerVine-OWNED shape stored in
 * bundle_prospects.payload. Scraper-native formats (Apify actor items,
 * pipeline PeopleRecords) never reach the database: the offline publish
 * script converts them to this contract, and the sync path converts this
 * contract to the import engine's MappedPerson. Swapping scrapers, or a
 * scraper changing its output, can never strand published bundle data.
 *
 * Versioning: bundle_prospects.payload_schema_version says which contract a
 * row uses. Readers must route through parseBundleProspectPayload, which
 * skips-and-reports unknown versions instead of throwing, so a future v2
 * rollout can't crash v1 sync code mid-loop.
 *
 * Pure module — no DB access.
 */

import { z } from "zod";
import {
  canonicalizeLinkedinUrl,
  extractPublicIdentifier,
  extractCompanyUniversalName,
  isInternalLinkedinId,
} from "./linkedin-url";
import type { MappedPerson, MappedEmployment, MappedEducation } from "./scrape-mapper";

export const BUNDLE_PAYLOAD_SCHEMA_VERSION = 1;

// ── Schema ─────────────────────────────────────────────────────────────

const monthText = z.string().trim().min(1).nullable();

const bundleExperienceSchema = z.object({
  title: z.string().trim().min(1).nullable(),
  company: z
    .object({
      name: z.string().trim().min(1).nullable(),
      linkedin_company_id: z.string().trim().min(1).nullable().optional(),
      linkedin_url: z.string().trim().min(1).nullable().optional(),
      universal_name: z.string().trim().min(1).nullable().optional(),
    })
    .refine((c) => c.name || c.linkedin_company_id, {
      message: "experience company needs a name or linkedin_company_id",
    }),
  start_month: monthText.optional(),
  end_month: monthText.optional(),
  is_current: z.boolean(),
  workplace_type: z.enum(["on_site", "hybrid", "remote"]).nullable().optional(),
  employment_type: z.string().trim().min(1).nullable().optional(),
  location_raw: z.string().trim().min(1).nullable().optional(),
});

const bundleEducationSchema = z.object({
  school_name: z.string().trim().min(1),
  degree: z.string().trim().min(1).nullable().optional(),
  field_of_study: z.string().trim().min(1).nullable().optional(),
  start_year: z.number().int().nullable().optional(),
  end_year: z.number().int().nullable().optional(),
});

const bundleEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  source: z.enum(["scraped", "pattern_guessed", "verified"]),
});

export const bundleProspectPayloadV1Schema = z.object({
  name: z.string().trim().min(1),
  linkedin_url: z
    .string()
    .trim()
    .min(1)
    .transform((url, ctx) => {
      const canonical = canonicalizeLinkedinUrl(url);
      if (!canonical) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a usable LinkedIn profile URL: "${url}"` });
        return z.NEVER;
      }
      return canonical;
    }),
  public_identifier: z.string().trim().min(1).nullable().optional(),
  headline: z.string().trim().min(1).nullable().optional(),
  /** Stable field: CAR-24 photo mirroring swaps the value, not the contract. */
  photo_url: z.string().trim().url().nullable().optional(),
  location: z
    .object({
      city: z.string().trim().min(1).nullable(),
      state: z.string().trim().min(1).nullable(),
      country: z.string().trim().min(1).nullable(),
    })
    .nullable()
    .optional(),
  location_raw: z.string().trim().min(1).nullable().optional(),
  emails: z.array(bundleEmailSchema).default([]),
  experiences: z.array(bundleExperienceSchema).default([]),
  education: z.array(bundleEducationSchema).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
});

export type BundleProspectPayloadV1 = z.infer<typeof bundleProspectPayloadV1Schema>;

/** Company entry in a bundle publish request (mirrors the target-companies
 * import fields; offices establish shared company_locations rows). */
export const bundleCompanyEntrySchema = z.object({
  name: z.string().trim().min(1),
  linkedin_company_id: z.string().trim().min(1).nullable().optional(),
  linkedin_url: z.string().trim().min(1).nullable().optional(),
  universal_name: z.string().trim().min(1).nullable().optional(),
  offices: z
    .array(
      z.object({
        city: z.string().trim().min(1).nullable(),
        state: z.string().trim().min(1).nullable(),
        country: z.string().trim().min(1).nullable().optional(),
      }),
    )
    .default([]),
});

export type BundleCompanyEntry = z.infer<typeof bundleCompanyEntrySchema>;

// ── Read-side parsing (skip-and-report on unknown versions) ────────────

export type ParsedBundlePayload =
  | { ok: true; payload: BundleProspectPayloadV1 }
  | { ok: false; reason: string };

/**
 * Parse a stored bundle_prospects payload. Never throws: sync loops must
 * degrade a bad row to a reported skip, not a crashed subscription.
 */
export function parseBundleProspectPayload(payload: unknown, schemaVersion: number): ParsedBundlePayload {
  if (schemaVersion !== BUNDLE_PAYLOAD_SCHEMA_VERSION) {
    return { ok: false, reason: `unknown_payload_schema_version:${schemaVersion}` };
  }
  const parsed = bundleProspectPayloadV1Schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: `invalid_payload:${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  return { ok: true, payload: parsed.data };
}

// ── Adapter: payload → import engine input ─────────────────────────────

export interface BundleImportContext {
  bundleId: number;
  bundleSlug: string;
  bundleVersion: number;
}

/** Pick the best email when a payload carries several: verified beats
 * scraped beats pattern_guessed, matching the contact_emails source ladder. */
const EMAIL_RANK: Record<BundleProspectPayloadV1["emails"][number]["source"], number> = {
  verified: 3,
  scraped: 2,
  pattern_guessed: 1,
};

export function pickBestBundleEmail(
  emails: BundleProspectPayloadV1["emails"],
): MappedPerson["email"] {
  let best: MappedPerson["email"] = null;
  let bestRank = 0;
  for (const e of emails) {
    const rank = EMAIL_RANK[e.source];
    if (rank > bestRank) {
      best = { address: e.email, source: e.source };
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Convert a validated payload to the import engine's MappedPerson with
 * bundle provenance. The result feeds importPeopleChunk's pre-mapped input
 * path with mergePolicy 'bundle'.
 */
export function payloadToMappedPerson(
  payload: BundleProspectPayloadV1,
  ctx: BundleImportContext,
): MappedPerson {
  const canonicalUrl = payload.linkedin_url; // canonicalized by the schema transform
  const slug = canonicalUrl.slice(canonicalUrl.lastIndexOf("/") + 1);

  const employment: MappedEmployment[] = payload.experiences.map((exp) => ({
    title: exp.title,
    company_name: exp.company.name,
    linkedin_company_id: exp.company.linkedin_company_id ?? null,
    company_linkedin_url: exp.company.linkedin_url ?? null,
    company_universal_name:
      exp.company.universal_name ?? extractCompanyUniversalName(exp.company.linkedin_url ?? null),
    start_month: exp.start_month ?? null,
    end_month: exp.is_current ? "Present" : (exp.end_month ?? null),
    is_current: exp.is_current,
    workplace_type: exp.workplace_type ?? null,
    employment_type: exp.employment_type ?? null,
    location_raw: exp.location_raw ?? null,
  }));

  const education: MappedEducation[] = payload.education.map((edu) => ({
    school_name: edu.school_name,
    degree: edu.degree ?? null,
    field_of_study: edu.field_of_study ?? null,
    start_year: edu.start_year ?? null,
    end_year: edu.end_year ?? null,
  }));

  return {
    name: payload.name,
    linkedin_url: canonicalUrl,
    public_identifier: payload.public_identifier ?? extractPublicIdentifier(canonicalUrl),
    non_vanity_url: isInternalLinkedinId(slug),
    headline: payload.headline ?? null,
    persona: null,
    review_note: null,
    verified_school: null,
    network_status: "prospect",
    network_scope: "target_company",
    import_source: `bundle:${ctx.bundleSlug}`,
    import_meta: {
      bundle_id: ctx.bundleId,
      bundle_slug: ctx.bundleSlug,
      bundle_version: ctx.bundleVersion,
    },
    tags: payload.tags,
    history_highlights: null,
    profile_location_raw: payload.location_raw ?? null,
    profile_location: payload.location ?? null,
    photo_url: payload.photo_url ?? null,
    email: pickBestBundleEmail(payload.emails),
    employment,
    education,
    warnings: [],
  };
}
