import { withApiHandler } from "@/lib/api-handler";
import { contactsImportSchema } from "@/lib/api-schemas";
import { sanitizeForPostgrest, buildUpdateData, buildContactData } from '@/lib/import-helpers';
import { handleOptions } from '@/lib/extension-auth';
import { backfillEmailsForContact } from "@/lib/gmail";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { findOrCreateCompany, findOrCreateLocation, ensureCompanyLocation } from "@/lib/company-helpers";
import { addTagsToContact, downloadAndStorePhoto } from "@/lib/import-db-helpers";
import { triggerEnrichOnSave } from "@/lib/apify/scrape-service";
import { normalizeLocation, normalizeParsedLocation, locationMatchKey } from "@/lib/location-normalizer";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types for the Chrome extension's profile payload ───────────────────

interface ProfileLocation {
  city: string | null;
  state: string | null;
  country: string;
}

interface ProfileExperience {
  company: string;
  title?: string;
  location?: string | null;
  workplace_type?: string | null;
  start_month?: string | null;
  end_month?: string | null;
  is_current?: boolean;
}

interface ProfileEducation {
  school: string;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: string | null;
  end_year?: string | null;
}

interface ProfileData {
  name?: string;
  linkedin_url?: string;
  location?: ProfileLocation;
  experience?: ProfileExperience[];
  education?: ProfileEducation[];
  suggested_tags?: string[];
  tags?: string[];
  contactInfo?: { email?: string };
  [key: string]: unknown;
}

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

interface TagLinkRow {
  tag_id: number;
}

// ── Route ──────────────────────────────────────────────────────────────

export async function OPTIONS() {
  return handleOptions();
}

export const POST = withApiHandler({
  schema: contactsImportSchema,
  extensionAuth: true,
  cors: true,
  handler: async ({ supabase, user, body }) => {
    const { profileData, photoUrl } = body as { profileData: ProfileData; photoUrl?: string };

    // Canonicalize before any dedupe — trailing slash / www / case
    // variants must land on the same contact row.
    const canonical = canonicalizeLinkedinUrl(profileData.linkedin_url ?? (profileData.profileUrl as string | undefined));
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

    // Backfill orphaned emails in the background
    if (profileData.contactInfo?.email) {
      backfillEmailsForContact(user.id, contact.id, [profileData.contactInfo.email])
        .catch((err) => console.warn("[import] Email backfill failed:", err));
    }

    // Handle photo download and storage (never blocks import)
    if (photoUrl) {
      try {
        await downloadAndStorePhoto(supabase, user.id, contact.id, photoUrl);
      } catch (err) {
        console.warn(`[import] Photo download/storage failed for contact ${contact.id}:`, err);
      }
    }

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
    const { city, state, country } = profileData.location;
    if (city || state || country) {
      const location = await findOrCreateLocation(supabase, {
        city: city || null, state: state || null, country: country || 'United States'
      });
      updateData.location_id = location.id;
    }
  }

  const { data: contact, error: updateError } = await supabase
    .from('contacts')
    .update(updateData)
    .eq('id', contactId)
    .eq('user_id', userId)
    .select()
    .single();

  if (updateError || !contact) throw new Error(updateError?.message || 'Failed to update contact');

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

  // Upsert primary email if provided (basic format check)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (profileData.contactInfo?.email && emailRegex.test(profileData.contactInfo.email) && profileData.contactInfo.email.length <= 320) {
    const { data: existingEmails } = await supabase
      .from('contact_emails')
      .select('id, email, is_primary')
      .eq('contact_id', contactId);

    const existing = (existingEmails || []).find(
      (e: any) => e.email.toLowerCase() === profileData.contactInfo!.email!.toLowerCase()
    );
    if (!existing) {
      // If no emails exist yet, make it primary; otherwise add as non-primary
      const hasPrimary = (existingEmails || []).some((e: any) => e.is_primary);
      const { error: emailError } = await supabase.from('contact_emails').insert({
        contact_id: contactId,
        email: profileData.contactInfo.email,
        is_primary: !hasPrimary,
      });
      if (emailError) {
        console.warn(`[import] Failed to add email for contact ${contactId}:`, emailError.message);
      }
    }
  }

  const tags = profileData.suggested_tags || profileData.tags;
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, contactId, tags, userId);
  }

  return contact as ContactRow;
}

async function createNewContact(supabase: SupabaseClient, profileData: ProfileData, userId: string): Promise<ContactRow> {
  let locationId: number | null = null;
  if (profileData.location && typeof profileData.location === 'object') {
    const { city, state, country } = profileData.location;
    if (city || state || country) {
      const location = await findOrCreateLocation(supabase, {
        city: city || null,
        state: state || null,
        country: country || 'United States'
      });
      locationId = location.id;
    }
  }

  const contactData = buildContactData(profileData, userId, locationId);

  const { data: contact, error: insertError } = await supabase
    .from('contacts')
    .insert(contactData)
    .select()
    .single();

  if (insertError || !contact) throw new Error(insertError?.message || 'Failed to create contact');

  if (profileData.contactInfo?.email) {
    await supabase
      .from('contact_emails')
      .insert({
        contact_id: (contact as ContactRow).id,
        email: profileData.contactInfo.email,
        is_primary: true
      });
  }

  if (profileData.experience && profileData.experience.length > 0) {
    await addExperienceToContact(supabase, (contact as ContactRow).id, profileData.experience, profileData.location);
  }

  if (profileData.education && profileData.education.length > 0) {
    await addEducationToContact(supabase, (contact as ContactRow).id, profileData.education);
  }

  const tags = profileData.suggested_tags || profileData.tags;
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
  const validExps = experience.filter(exp => exp.company);
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
        // 'manual' rows (migration 20260709030000)
        source: 'extension',
      });
    }
  }
  if (toInsert.length > 0) {
    await supabase.from('contact_companies').insert(toInsert);
  }
}

async function addEducationToContact(supabase: SupabaseClient, contactId: number, education: ProfileEducation[], skipDedup = false) {
  const validEdus = education.filter(edu => edu.school);
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
