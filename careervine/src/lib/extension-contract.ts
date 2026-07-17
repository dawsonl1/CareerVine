/**
 * CAR-148 (F11) — the single validated contract for every request the Chrome
 * extension sends the web app. There are four such endpoints:
 *   - POST /api/contacts/import         (profile → contact)
 *   - POST /api/extension/parse-profile (page text → structured profile)
 *   - POST /api/contacts/check-duplicate
 *   - POST /api/extension/ping          (liveness)
 *
 * The profile shape used to be hand-mirrored in three places and the import
 * body was `z.record(z.string(), z.unknown())` — the wire validated nothing.
 * Now:
 *   - `ProfileData` (the TS type) lives once, in the panel's zod-free
 *     `@panel/lib/profile-contract`, so both the panel's standalone build (no
 *     zod) and this file can share it.
 *   - `profileDataSchema` (below) is the real validator, derived by hand from
 *     that type. The `_typeParity` assertions at the bottom make the web app
 *     build fail if the schema's inferred output drifts from `ProfileData`, and
 *     `extension-contract.test.ts` re-checks it as a parity test.
 *
 * Backward-compatibility (FIELD CONTRACT): the schema is a strip object with the
 * full shipped field set declared, so malformed KNOWN fields reject (400) while
 * unknown/legacy keys are tolerated (stripped, never rejected). Fields that are
 * always present after parsing/enrichment carry `.default(...)` so the inferred
 * OUTPUT type matches the panel's post-enrich invariants.
 */

import { z } from "zod";
import type {
  ProfileData,
  ProfileLocation,
  ProfileExperience,
  ProfileEducation,
} from "@panel/lib/profile-contract";

export type { ProfileData, ProfileLocation, ProfileExperience, ProfileEducation };

// ── Profile payload ─────────────────────────────────────────────────────

const profileLocationSchema = z.object({
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
});

const profileExperienceSchema = z.object({
  id: z.string().optional(),
  company: z.string().optional(),
  title: z.string().nullish(),
  location: z.string().nullish(),
  workplace_type: z.string().nullish(),
  start_month: z.string().nullish(),
  end_month: z.string().nullish(),
  is_current: z.boolean().optional(),
});

const profileEducationSchema = z.object({
  id: z.string().optional(),
  school: z.string().optional(),
  degree: z.string().nullish(),
  field_of_study: z.string().nullish(),
  start_year: z.string().nullish(),
  end_year: z.string().nullish(),
  is_current: z.boolean().optional(),
});

/**
 * The real validator for a scraped/edited LinkedIn profile. Every KNOWN field is
 * typed so a malformed payload (e.g. `experience` as a string, `location` as a
 * scalar) is rejected 400 at the wire; unknown keys are stripped, not rejected,
 * so older extension builds that send extra fields keep working.
 */
export const profileDataSchema = z.object({
  // Identity
  name: z.string().optional(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  profileUrl: z.string().nullish(),
  industry: z.string().nullish(),
  headline: z.string().nullish(),
  about: z.string().nullish(),

  // Always present after parse (server) / enrichProfile (panel) via defaults.
  location: profileLocationSchema.default({}),
  experience: z.array(profileExperienceSchema).default([]),
  education: z.array(profileEducationSchema).default([]),
  suggested_tags: z.array(z.string()).default([]),
  contact_status: z.enum(["student", "professional"]).nullable().default(null),

  // Optional metadata
  tags: z.array(z.string()).optional(),
  expected_graduation: z.string().nullish(),
  follow_up_frequency: z.string().nullish(),
  follow_up_frequency_days: z.number().nullish(),
  notes: z.string().nullish(),
  generated_notes: z.string().nullish(),
  email: z.string().nullish(),
  contactInfo: z.object({ email: z.string().optional() }).optional(),
  photo_url: z.string().nullish(),
  current_company: z.string().nullish(),
});

// ── The four extension endpoint request schemas + inferred types ─────────

/** POST /api/contacts/import */
export const extensionImportSchema = z.object({
  profileData: profileDataSchema,
  photoUrl: z.string().url().optional(),
});
export type ExtensionImportBody = z.infer<typeof extensionImportSchema>;

/** POST /api/extension/parse-profile */
export const extensionParseProfileSchema = z.object({
  // Cleaned profile text is typically <15k chars; the cap bounds OpenAI cost
  // if a buggy or malicious client posts raw page dumps.
  cleanedText: z
    .string()
    .min(1, "cleanedText is required")
    .max(60_000, "cleanedText is too long"),
  profileUrl: z.string().optional(),
});
export type ExtensionParseProfileBody = z.infer<typeof extensionParseProfileSchema>;

/** POST /api/contacts/check-duplicate */
export const extensionCheckDuplicateSchema = z.object({
  linkedinUrl: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});
export type ExtensionCheckDuplicateBody = z.infer<typeof extensionCheckDuplicateSchema>;

/** POST /api/extension/ping — liveness beacon, empty body. */
export const extensionPingSchema = z.object({});
export type ExtensionPingBody = z.infer<typeof extensionPingSchema>;

// ── Parse-profile OpenAI structured-output schema ────────────────────────
// The JSON schema OpenAI must return from parse-profile. It is a strict SUBSET
// of `profileDataSchema` (parse output feeds directly into the import wire), so
// `extension-contract.test.ts` asserts every property here is a known field of
// `profileDataSchema` — a field rename on one side turns that test red.

export const parseProfileJsonSchema = {
  name: "linkedin_profile",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "first_name",
      "last_name",
      "location",
      "industry",
      "generated_notes",
      "suggested_tags",
      "experience",
      "education",
    ],
    properties: {
      first_name: { type: "string", maxLength: 40 },
      last_name: { type: "string", maxLength: 60 },
      location: {
        type: "object",
        additionalProperties: false,
        required: ["city", "state", "country"],
        properties: {
          city: { type: ["string", "null"], maxLength: 60 },
          state: { type: ["string", "null"], maxLength: 60 },
          country: { type: "string", default: "United States", maxLength: 60 },
        },
      },
      industry: { type: ["string", "null"], maxLength: 60 },
      generated_notes: { type: "string", maxLength: 420 },
      suggested_tags: {
        type: "array",
        minItems: 2,
        maxItems: 5,
        items: { type: "string", maxLength: 32 },
      },
      experience: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["company", "title", "location", "start_month", "end_month"],
          properties: {
            company: { type: "string", maxLength: 120 },
            title: { type: "string", maxLength: 120 },
            location: { type: ["string", "null"], maxLength: 120 },
            start_month: { type: ["string", "null"], maxLength: 12 },
            end_month: { type: ["string", "null"], maxLength: 12 },
          },
        },
      },
      education: {
        // Raised from 2 (CAR-95): capping at 2 could drop the entry that
        // drives student/professional classification when a person lists
        // several schools.
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["school", "degree", "field_of_study", "start_year", "end_year"],
          properties: {
            school: { type: "string", maxLength: 140 },
            degree: {
              type: ["string", "null"],
              enum: [null, "Bachelor's", "Master's", "PhD", "Associate's", "Certificate", "Diploma"],
            },
            field_of_study: { type: ["string", "null"], maxLength: 80 },
            start_year: { type: ["string", "null"], maxLength: 10 },
            end_year: { type: ["string", "null"], maxLength: 10 },
          },
        },
      },
    },
  },
  strict: true,
};

// ── Compile-time schema/type parity (CAR-148 exit criterion) ─────────────
// If `profileDataSchema`'s inferred output and the shared `ProfileData` type
// drift apart, one of these two lines fails to compile and the web app build
// goes red. `extension-contract.test.ts` re-asserts the same at test time.
type SchemaOutput = z.infer<typeof profileDataSchema>;
type _AssertSchemaMatchesType = SchemaOutput extends ProfileData ? true : never;
type _AssertTypeMatchesSchema = ProfileData extends SchemaOutput ? true : never;
export const _typeParity: [_AssertSchemaMatchesType, _AssertTypeMatchesSchema] = [true, true];
