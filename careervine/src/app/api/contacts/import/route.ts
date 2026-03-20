import { withApiHandler } from "@/lib/api-handler";
import { contactsImportSchema } from "@/lib/api-schemas";
import { sanitizeForPostgrest, buildUpdateData, buildContactData } from '@/lib/import-helpers';
import { handleOptions } from '@/lib/extension-auth';
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

    const duplicates = await findDuplicateContacts(supabase, user.id, profileData);

    let contact: ContactRow;
    let isUpdate = false;

    if (duplicates.exactMatch) {
      contact = await updateExistingContact(supabase, duplicates.exactMatch.id, profileData, user.id);
      isUpdate = true;
    } else {
      contact = await createNewContact(supabase, profileData, user.id);
    }

    // Handle photo download and storage (never blocks import)
    if (photoUrl) {
      try {
        await downloadAndStorePhoto(supabase, user.id, contact.id, photoUrl);
      } catch (err) {
        console.warn(`[import] Photo download/storage failed for contact ${contact.id}:`, err);
      }
    }

    return {
      success: true,
      contact,
      isUpdate,
      duplicates: duplicates.potentialMatches
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

  // Replace experience: back up old data, delete, insert new, restore on failure
  if (profileData.experience && profileData.experience.length > 0) {
    const { data: oldExp } = await supabase.from('contact_companies').select('*').eq('contact_id', contactId);
    await supabase.from('contact_companies').delete().eq('contact_id', contactId);
    try {
      await addExperienceToContact(supabase, contactId, profileData.experience, true);
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

  // Upsert primary email if provided
  if (profileData.contactInfo?.email) {
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
    await addExperienceToContact(supabase, (contact as ContactRow).id, profileData.experience);
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

async function addExperienceToContact(supabase: SupabaseClient, contactId: number, experience: ProfileExperience[], skipDedup = false) {
  const validExps = experience.filter(exp => exp.company);
  if (validExps.length === 0) return;

  const companyNames = [...new Set(validExps.map(exp => exp.company))];
  const companyResults = await Promise.all(
    companyNames.map(name =>
      supabase.from('companies').select('id, name').ilike('name', name).maybeSingle()
    )
  );

  const companyMap = new Map<string, { id: number; name: string }>();
  for (const { data } of companyResults) {
    if (data) companyMap.set((data as { id: number; name: string }).name.toLowerCase(), data as { id: number; name: string });
  }

  for (const name of companyNames) {
    if (!companyMap.has(name.toLowerCase())) {
      const { data: newCompany, error: insertErr } = await supabase
        .from('companies')
        .insert({ name })
        .select('id, name')
        .single();
      if (insertErr) {
        const { data: retry } = await supabase
          .from('companies')
          .select('id, name')
          .ilike('name', name)
          .maybeSingle();
        if (retry) companyMap.set((retry as { id: number; name: string }).name.toLowerCase(), retry as { id: number; name: string });
      } else if (newCompany) {
        companyMap.set((newCompany as { id: number; name: string }).name.toLowerCase(), newCompany as { id: number; name: string });
      }
    }
  }

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
    if (!relSet.has(key)) {
      toInsert.push({
        contact_id: contactId,
        company_id: company.id,
        title: exp.title || null,
        start_month: exp.start_month || null,
        end_month: exp.is_current ? 'Present' : (exp.end_month || null),
        is_current: exp.is_current || false,
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

async function findOrCreateLocation(supabase: SupabaseClient, location: { city: string | null; state: string | null; country: string }) {
  function buildLookup() {
    let q = supabase.from('locations').select('id, city, state, country');
    q = location.city ? q.eq('city', location.city) : q.is('city', null);
    q = location.state ? q.eq('state', location.state) : q.is('state', null);
    return q.eq('country', location.country);
  }

  const { data: existing } = await buildLookup().maybeSingle();
  if (existing) return existing as { id: number };

  const { data, error } = await supabase
    .from('locations')
    .insert({
      city: location.city,
      state: location.state,
      country: location.country,
    })
    .select('id')
    .single();
  if (error) {
    const { data: retry } = await buildLookup().maybeSingle();
    if (retry) return retry as { id: number };
    throw error;
  }
  return data as { id: number };
}

async function downloadAndStorePhoto(supabase: SupabaseClient, userId: string, contactId: number, photoUrl: string) {
  // SSRF protection: only allow LinkedIn CDN URLs
  const parsedUrl = new URL(photoUrl);
  if (parsedUrl.hostname !== 'media.licdn.com') {
    console.warn(`[import] Rejected non-LinkedIn photo URL hostname: ${parsedUrl.hostname}`);
    return;
  }

  // Fetch the image with a 5-second timeout covering headers + body
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  let imageBuffer: ArrayBuffer;
  try {
    response = await fetch(photoUrl, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`Photo fetch failed with status ${response.status}`);
    }
    imageBuffer = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }

  // Validate actual payload size (Content-Length can be absent or spoofed)
  if (imageBuffer.byteLength > 5 * 1024 * 1024) {
    console.warn(`[import] Photo too large: ${imageBuffer.byteLength} bytes`);
    return;
  }

  // Validate content-type is an image format
  const contentType = response.headers.get('content-type') || '';
  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const resolvedContentType = ALLOWED_IMAGE_TYPES.find(t => contentType.startsWith(t)) || 'image/jpeg';

  const storagePath = `${userId}/${contactId}.jpg`;

  // Upload photo (upsert handles re-imports atomically)
  const { error: uploadError } = await supabase.storage
    .from('contact-photos')
    .upload(storagePath, imageBuffer, {
      contentType: resolvedContentType,
      upsert: true,
    });
  if (uploadError) throw uploadError;

  // Get the public URL with cache-busting timestamp and update the contact record
  const { data: publicUrlData } = supabase.storage
    .from('contact-photos')
    .getPublicUrl(storagePath);
  const photoUrlWithCacheBust = `${publicUrlData.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase
    .from('contacts')
    .update({ photo_url: photoUrlWithCacheBust })
    .eq('id', contactId)
    .eq('user_id', userId);
  if (updateError) throw updateError;
}

async function addTagsToContact(supabase: SupabaseClient, contactId: number, tags: string[], userId: string) {
  const normalizedTags = [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
  if (normalizedTags.length === 0) return;

  const { data: existingTags } = await supabase
    .from('tags')
    .select('id, name')
    .eq('user_id', userId);
  const tagMap = new Map<string, { id: number; name: string }>();
  for (const t of (existingTags as { id: number; name: string }[] | null) || []) {
    tagMap.set(t.name.toLowerCase(), t);
  }

  for (const name of normalizedTags) {
    if (!tagMap.has(name)) {
      const { data: newTag } = await supabase
        .from('tags')
        .insert({ name, user_id: userId })
        .select('id, name')
        .single();
      if (newTag) tagMap.set((newTag as { id: number; name: string }).name.toLowerCase(), newTag as { id: number; name: string });
    }
  }

  const tagIds = normalizedTags.map(n => tagMap.get(n)?.id).filter(Boolean) as number[];
  const { data: existingLinks } = await supabase
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .in('tag_id', tagIds);
  const linkedSet = new Set(((existingLinks as TagLinkRow[] | null) || []).map(r => r.tag_id));

  const toInsert = tagIds
    .filter(id => !linkedSet.has(id))
    .map(tag_id => ({ contact_id: contactId, tag_id }));
  if (toInsert.length > 0) {
    await supabase.from('contact_tags').insert(toInsert);
  }
}
