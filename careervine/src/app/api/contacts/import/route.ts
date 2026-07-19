// ── FIELD CONTRACT — shipped extensions call this; changes must be
// backward-compatible. The request body is validated by `contactsImportSchema`
// (= `extensionImportSchema` in extension-contract.ts); the profile shape is the
// shared `ProfileData`. Never tighten a field or rename a wire key without a
// backward-compatible path — older installed extensions still POST the old shape.
import { withApiHandler } from "@/lib/api-handler";
import { contactsImportSchema } from "@/lib/api-schemas";
import { checkContactMilestone } from "@/lib/analytics/server";
import { advanceExtensionOnboarding } from "@/lib/onboarding/extension-server";
import { sanitizeForPostgrest, buildUpdateData, buildContactData, resolveProfileLocationId, isValidContactEmail, resolveImportTags } from '@/lib/import-helpers';
import { handleOptions } from '@/lib/extension-auth';
import { backfillEmailsForContact } from "@/lib/gmail";
import { syncContactEmailHistoryIfPaid } from "@/lib/contact-email-history";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { findOrCreateCompany, findOrCreateLocation, ensureCompanyLocation } from "@/lib/company-helpers";
import { addTagsToContact, downloadAndStorePhoto } from "@/lib/import-db-helpers";
import { createContact, updateContact } from "@/lib/data/contacts";
import type { QueryClient } from "@/lib/data/client";
import { triggerEnrichOnSave } from "@/lib/apify/scrape-service";
import { normalizeLocation, normalizeParsedLocation, locationMatchKey } from "@/lib/location-normalizer";
import type { SupabaseClient } from "@supabase/supabase-js";
// CAR-148 (F11): the profile payload shape is single-sourced. `ProfileData` and
// its row types come from the extension contract — do not re-declare them here.
import type {
  ProfileData,
  ProfileLocation,
  ProfileExperience,
  ProfileEducation,
} from "@/lib/extension-contract";

interface ContactRow {
  id: number;
  [key: string]: unknown;
}

interface CompanyRelRow {
  company_id: number;
  title: string | null;
}

interface SchoolRelRow {
  school_id: number;
}

// ── Route ──────────────────────────────────────────────────────────────

export async function OPTIONS() {
  return handleOptions();
}

export const POST = withApiHandler({
  schema: contactsImportSchema,
  extensionAuth: true,
  cors: true,
  handler: async ({ supabase, user, body, track }) => {
    const { profileData, photoUrl } = body;

    // Canonicalize before any dedupe — trailing slash / www / case
    // variants must land on the same contact row.
    const canonical = canonicalizeLinkedinUrl(profileData.linkedin_url ?? profileData.profileUrl);
    if (canonical) {
      profileData.linkedin_url = canonical;
      profileData.profileUrl = canonical;
    }

    const duplicates = await findDuplicateContacts(supabase, user.id, profileData);

    let contact: ContactRow;
    let isUpdate = false;

    if (duplicates.exactMatch) {
      contact = await updateExistingContact(supabase, duplicates.exactMatch.id, profileData, user.id);
      isUpdate = true;
    } else {
      contact = await createNewContact(supabase, profileData, user.id);
    }

    // Surface prior correspondence on the contact (CAR-109 #1). Gate on the same
    // validity check the primary-email insert uses (CAR-148), so a malformed
    // address that never gets stored also doesn't drive a no-op backfill/sync.
    const priorEmail = profileData.contactInfo?.email;
    if (isValidContactEmail(priorEmail)) {
      const email = priorEmail;
      // Cheap, every tier: re-link any already-cached orphan rows for this address.
      backfillEmailsForContact(user.id, contact.id, [email])
        .catch((err) => console.warn("[import] Email backfill failed:", err));
      // Paid tier only: fetch this person's Gmail history so emails you exchanged
      // before they were a contact show on their profile. No-op on free tier
      // (no mailbox:read scope). Awaited for reliability; never fails the import.
      try {
        await syncContactEmailHistoryIfPaid(user.id, contact.id, [email]);
      } catch (err) {
        console.warn("[import] Prior email history sync failed:", err);
      }
    }

    // Handle photo download and storage (never blocks import)
    if (photoUrl) {
      try {
        await downloadAndStorePhoto(supabase, user.id, contact.id, photoUrl);
      } catch (err) {
        console.warn(`[import] Photo download/storage failed for contact ${contact.id}:`, err);
      }
    }

    if (!isUpdate) {
      track("contact_imported", { source: "extension" });
      await checkContactMilestone(user.id);
    }

    // CAR-68: advance the extension-onboarding flow when its waited-on import
    // arrives. Best-effort — a failed advance must never fail the import.
    await advanceExtensionOnboarding(supabase, user.id, contact.id, isValidContactEmail(profileData.contactInfo?.email));

    // Auto-enrich (plan 29): kick off an Apify scrape that fills photo, real
    // employment history, and a verified email. Async — the run completes via
    // webhook minutes later; the save itself never waits on or fails from it.
    const enrich = await triggerEnrichOnSave(user.id, contact.id);

    return {
      success: true,
      contact,
      isUpdate,
      duplicates: duplicates.potentialMatches,
      enrich: enrich.status,
    };
  },
});

// ── Helpers ────────────────────────────────────────────────────────────

async function findDuplicateContacts(supabase: SupabaseClient, userId: string, profileData: ProfileData) {
  let exactMatch: ContactRow | null = null;
  if (profileData.linkedin_url) {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('linkedin_url', profileData.linkedin_url)
      .single();

    exactMatch = data as ContactRow | null;
  }

  let potentialMatches: ContactRow[] = [];
  if (profileData.name && !exactMatch) {
    const names = profileData.name.split(' ');
    if (names.length >= 2) {
      const firstName = sanitizeForPostgrest(names[0]);
      const lastName = sanitizeForPostgrest(names[names.length - 1]);

      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', userId)
        .or(`name.ilike.%${firstName}%,name.ilike.%${lastName}%`);

      potentialMatches = (data as ContactRow[] | null) || [];
    }
  }

  return {
    exactMatch,
    potentialMatches: potentialMatches.filter(match => match.id !== exactMatch?.id)
  };
}

async function updateExistingContact(supabase: SupabaseClient, contactId: number, profileData: ProfileData, userId: string): Promise<ContactRow> {
  const updateData = buildUpdateData(profileData);

  if (profileData.location && typeof profileData.location === 'object') {
    const locationId = await resolveProfileLocationId(supabase, profileData.location);
    if (locationId != null) updateData.location_id = locationId;
  }

  // Shared write chokepoint (CAR-155): canonicalization runs inside.
  let contact: ContactRow;
  try {
    contact = (await updateContact(contactId, updateData, {
      client: supabase as unknown as QueryClient,
      userId,
    })) as ContactRow;
  } catch (err) {
    // PostgREST errors are message-bearing objects, not Error instances.
    throw new Error((err as { message?: string })?.message ?? 'Failed to update contact');
  }

  // Replace experience — but only the rows THIS path owns (source='extension').
  // Scraped rows carry provenance (location_id, scraped_at) the AI parse can't
  // reproduce, and manual rows are user-typed; deleting either on a re-save
  // would destroy better data (plan 29 m6). New inserts dedupe against the
  // survivors so a role the scrape already covers isn't re-added.
  if (profileData.experience && profileData.experience.length > 0) {
    const { data: oldExp } = await supabase
      .from('contact_companies')
      .select('*')
      .eq('contact_id', contactId)
      .eq('source', 'extension');
    await supabase.from('contact_companies').delete().eq('contact_id', contactId).eq('source', 'extension');
    try {
      await addExperienceToContact(supabase, contactId, profileData.experience, profileData.location, false);
    } catch (err) {
      if (oldExp && oldExp.length > 0) {
        await supabase.from('contact_companies').insert(oldExp.map(({ id: _id, ...rest }) => rest));
      }
      throw err;
    }
  }

  // Replace education: same backup/restore pattern
  if (profileData.education && profileData.education.length > 0) {
    const { data: oldEdu } = await supabase.from('contact_schools').select('*').eq('contact_id', contactId);
    await supabase.from('contact_schools').delete().eq('contact_id', contactId);
    try {
      await addEducationToContact(supabase, contactId, profileData.education, true);
    } catch (err) {
      if (oldEdu && oldEdu.length > 0) {
        await supabase.from('contact_schools').insert(oldEdu.map(({ id: _id, ...rest }) => rest));
      }
      throw err;
    }
  }

  // Upsert primary email if provided. Shared validity gate with the create
  // path (isValidContactEmail) so both paths accept/reject identically.
  const primaryEmail = profileData.contactInfo?.email;
  if (isValidContactEmail(primaryEmail)) {
    const { data: existingEmails } = await supabase
      .from('contact_emails')
      .select('id, email, is_primary')
      .eq('contact_id', contactId);

    const existing = (existingEmails || []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      (e: any) => e.email.toLowerCase() === primaryEmail.toLowerCase()
    );
    if (!existing) {
      // If no emails exist yet, make it primary; otherwise add as non-primary
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      const hasPrimary = (existingEmails || []).some((e: any) => e.is_primary);
      const { error: emailError } = await supabase.from('contact_emails').insert({
        contact_id: contactId,
        email: primaryEmail,
        is_primary: !hasPrimary,
      });
      if (emailError) {
        console.warn(`[import] Failed to add email for contact ${contactId}:`, emailError.message);
      }
    }
  }

  const tags = resolveImportTags(profileData);
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, contactId, tags, userId);
  }

  return contact as ContactRow;
}

async function createNewContact(supabase: SupabaseClient, profileData: ProfileData, userId: string): Promise<ContactRow> {
  let locationId: number | null = null;
  if (profileData.location && typeof profileData.location === 'object') {
    locationId = await resolveProfileLocationId(supabase, profileData.location);
  }

  const contactData = buildContactData(profileData, userId, locationId);

  // Shared write chokepoint (CAR-155): canonicalization runs inside.
  let contact: ContactRow;
  try {
    contact = (await createContact(
      contactData as unknown as Parameters<typeof createContact>[0],
      { client: supabase as unknown as QueryClient },
    )) as ContactRow;
  } catch (err) {
    // PostgREST errors are message-bearing objects, not Error instances.
    throw new Error((err as { message?: string })?.message ?? 'Failed to create contact');
  }

  // Same validity gate as the update path — a malformed email is skipped, not
  // inserted raw on first import (CAR-148 F11).
  const newEmail = profileData.contactInfo?.email;
  if (isValidContactEmail(newEmail)) {
    await supabase
      .from('contact_emails')
      .insert({
        contact_id: (contact as ContactRow).id,
        email: newEmail,
        is_primary: true
      });
  }

  if (profileData.experience && profileData.experience.length > 0) {
    await addExperienceToContact(supabase, (contact as ContactRow).id, profileData.experience, profileData.location);
  }

  if (profileData.education && profileData.education.length > 0) {
    await addEducationToContact(supabase, (contact as ContactRow).id, profileData.education);
  }

  const tags = resolveImportTags(profileData);
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, (contact as ContactRow).id, tags, userId);
  }

  return contact as ContactRow;
}

function normalizeWorkplaceType(
  workplaceType: string | null | undefined,
  locationText: string | null | undefined,
): "on_site" | "hybrid" | "remote" | null {
  const normalized = (workplaceType || "").trim().toLowerCase();
  if (["on-site", "on site", "onsite"].includes(normalized)) return "on_site";
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "remote") return "remote";
  if ((locationText || "").toLowerCase().includes("remote")) return "remote";
  return null;
}

async function addExperienceToContact(
  supabase: SupabaseClient,
  contactId: number,
  experience: ProfileExperience[],
  profileLocation?: ProfileLocation,
  skipDedup = false,
) {
  const validExps = experience.filter(
    (exp): exp is ProfileExperience & { company: string } => Boolean(exp.company),
  );
  if (validExps.length === 0) return;

  // Consolidated find-or-create (escaped ilike — company names containing
  // % or _ no longer act as wildcards)
  const companyNames = [...new Set(validExps.map(exp => exp.company))];
  const companyMap = new Map<string, { id: number; name: string }>();
  for (const name of companyNames) {
    try {
      const company = await findOrCreateCompany(supabase, { name });
      companyMap.set(name.toLowerCase(), company);
    } catch (err) {
      console.warn(`[import] Failed to find/create company "${name}":`, err);
    }
  }

  const locationIdCache = new Map<string, number>();
  async function resolveLocationId(locationRaw: string) {
    const norm = normalizeLocation(locationRaw);
    const key = locationMatchKey(norm);
    if (!key || !norm.city) return null;
    const cached = locationIdCache.get(key);
    if (cached != null) return cached;
    const location = await findOrCreateLocation(supabase, {
      city: norm.city,
      state: norm.state,
      country: norm.country || 'United States',
    });
    locationIdCache.set(key, location.id);
    return location.id;
  }

  // Known company offices (rule-2 anchor)
  const officeByCompany = new Map<number, Map<string, number>>();
  const companyIds = Array.from(new Set(Array.from(companyMap.values()).map(c => c.id)));
  if (companyIds.length > 0) {
    const { data: officeRows } = await supabase
      .from('company_locations')
      .select('company_id, location_id, locations(city, state, country)')
      .in('company_id', companyIds);

    for (const row of ((officeRows as Array<{
      company_id: number;
      location_id: number;
      locations: { city: string | null; state: string | null; country: string } | null;
    }> | null) || [])) {
      if (!row.locations) continue;
      const key = locationMatchKey(normalizeParsedLocation(row.locations));
      if (!key) continue;
      if (!officeByCompany.has(row.company_id)) officeByCompany.set(row.company_id, new Map());
      officeByCompany.get(row.company_id)!.set(key, row.location_id);
    }
  }

  const profileNormKey = profileLocation
    ? locationMatchKey(normalizeParsedLocation(profileLocation))
    : null;

  let relSet = new Set<string>();
  if (!skipDedup) {
    const { data: existingRels } = await supabase
      .from('contact_companies')
      .select('company_id, title')
      .eq('contact_id', contactId);
    relSet = new Set(((existingRels as CompanyRelRow[] | null) || []).map(r =>
      `${r.company_id}:${r.title || ''}`
    ));
  }

  const toInsert = [];
  for (const exp of validExps) {
    const company = companyMap.get(exp.company.toLowerCase());
    if (!company) continue;
    const key = `${company.id}:${exp.title || ''}`;

    const locationRaw = exp.location || null;
    const workplaceType = normalizeWorkplaceType(exp.workplace_type, exp.location);
    const locationNorm = exp.location ? normalizeLocation(exp.location) : null;
    const isRemote = workplaceType === 'remote' || Boolean(locationNorm?.isRemote);
    let locationId: number | null = null;
    let locationSource: 'experience' | 'profile_match' | null = null;

    // Rule 1: explicit experience location can establish office.
    if (!isRemote && locationNorm?.canEstablishOffice && exp.location) {
      locationId = await resolveLocationId(exp.location);
      if (locationId != null) {
        locationSource = 'experience';
        await ensureCompanyLocation(supabase, company.id, locationId, 'scraped');
        const locKey = locationMatchKey(locationNorm);
        if (locKey) {
          if (!officeByCompany.has(company.id)) officeByCompany.set(company.id, new Map());
          officeByCompany.get(company.id)!.set(locKey, locationId);
        }
      }
    }

    // Rule 2: current role with no location, match profile location to known office.
    if (
      locationId == null &&
      exp.is_current &&
      !isRemote &&
      profileNormKey &&
      officeByCompany.get(company.id)?.has(profileNormKey)
    ) {
      locationId = officeByCompany.get(company.id)!.get(profileNormKey)!;
      locationSource = 'profile_match';
    }

    if (!relSet.has(key)) {
      toInsert.push({
        contact_id: contactId,
        company_id: company.id,
        title: exp.title || null,
        start_month: exp.start_month || null,
        end_month: exp.is_current ? 'Present' : (exp.end_month || null),
        is_current: exp.is_current || false,
        location_id: locationId,
        location_source: locationSource,
        location_raw: locationRaw,
        workplace_type: workplaceType,
        // AI-parsed provenance: supersedable by scrapes, unlike user-typed
        // 'manual' rows (migration 20260710030000)
        source: 'extension',
      });
    }
  }
  if (toInsert.length > 0) {
    await supabase.from('contact_companies').insert(toInsert);
  }
}

async function addEducationToContact(supabase: SupabaseClient, contactId: number, education: ProfileEducation[], skipDedup = false) {
  const validEdus = education.filter(
    (edu): edu is ProfileEducation & { school: string } => Boolean(edu.school),
  );
  if (validEdus.length === 0) return;

  const schoolNames = [...new Set(validEdus.map(edu => edu.school))];
  const schoolResults = await Promise.all(
    schoolNames.map(name =>
      supabase.from('schools').select('id, name').ilike('name', name).maybeSingle()
    )
  );

  const schoolMap = new Map<string, { id: number; name: string }>();
  for (const { data } of schoolResults) {
    if (data) schoolMap.set((data as { id: number; name: string }).name.toLowerCase(), data as { id: number; name: string });
  }

  for (const name of schoolNames) {
    if (!schoolMap.has(name.toLowerCase())) {
      const { data: newSchool, error: insertErr } = await supabase
        .from('schools')
        .insert({ name })
        .select('id, name')
        .single();
      if (insertErr) {
        const { data: retry } = await supabase
          .from('schools')
          .select('id, name')
          .ilike('name', name)
          .maybeSingle();
        if (retry) schoolMap.set((retry as { id: number; name: string }).name.toLowerCase(), retry as { id: number; name: string });
      } else if (newSchool) {
        schoolMap.set((newSchool as { id: number; name: string }).name.toLowerCase(), newSchool as { id: number; name: string });
      }
    }
  }

  let relSet = new Set<number>();
  if (!skipDedup) {
    const { data: existingRels } = await supabase
      .from('contact_schools')
      .select('school_id')
      .eq('contact_id', contactId);
    relSet = new Set(((existingRels as SchoolRelRow[] | null) || []).map(r => r.school_id));
  }

  const toInsert = [];
  for (const edu of validEdus) {
    const school = schoolMap.get(edu.school.toLowerCase());
    if (!school || relSet.has(school.id)) continue;
    toInsert.push({
      contact_id: contactId,
      school_id: school.id,
      degree: edu.degree || null,
      field_of_study: edu.field_of_study || null,
      start_year: edu.start_year ? parseInt(String(edu.start_year), 10) || null : null,
      end_year: edu.end_year ? parseInt(String(edu.end_year), 10) || null : null,
    });
  }
  if (toInsert.length > 0) {
    await supabase.from('contact_schools').insert(toInsert);
  }
}

// findOrCreateLocation, downloadAndStorePhoto and addTagsToContact moved to
// shared modules (company-helpers.ts / import-db-helpers.ts) so the bulk
// pipeline import uses the same implementations.
