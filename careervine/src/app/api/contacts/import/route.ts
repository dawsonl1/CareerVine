import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server-client';
import { parseFollowUpFrequency, sanitizeForPostgrest, buildUpdateData, buildContactData } from '@/lib/import-helpers';

/**
 * API endpoint for importing contacts from Chrome extension
 * Handles duplicate detection and creates contact with related data
 */

// CORS headers for Chrome extension
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Handle OPTIONS preflight request
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    // Check for Authorization header (from Chrome extension)
    const authHeader = request.headers.get('authorization');
    let supabase;
    
    if (authHeader?.startsWith('Bearer ')) {
      // Chrome extension auth - create client with token
      const token = authHeader.substring(7);
      const { createClient } = await import('@supabase/supabase-js');
      const { getSupabaseEnv } = await import('@/lib/supabase/config');
      const { url, anonKey } = getSupabaseEnv();
      
      supabase = createClient(url, anonKey, {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      });
    } else {
      // Web app auth - use cookies
      supabase = await createSupabaseServerClient();
    }
    
    // Get user from session
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    }

    const { profileData } = await request.json();

    // Check for duplicates
    const duplicates = await findDuplicateContacts(supabase, user.id, profileData);

    let contact;
    let isUpdate = false;

    if (duplicates.exactMatch) {
      contact = await updateExistingContact(supabase, duplicates.exactMatch.id, profileData, user.id);
      isUpdate = true;
    } else {
      contact = await createNewContact(supabase, profileData, user.id);
    }

    return NextResponse.json({ 
      success: true, 
      contact,
      isUpdate,
      duplicates: duplicates.potentialMatches 
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Import error:', error);
    return NextResponse.json({ 
      error: 'Import failed'
    }, { status: 500, headers: corsHeaders });
  }
}

async function findDuplicateContacts(supabase: any, userId: string, profileData: any) {
  
  // Check for exact LinkedIn URL match
  let exactMatch = null;
  if (profileData.linkedin_url) {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('linkedin_url', profileData.linkedin_url)
      .single();
    
    exactMatch = data;
  }

  // Check for name matches
  let potentialMatches = [];
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
      
      potentialMatches = data || [];
    }
  }

  return {
    exactMatch,
    potentialMatches: potentialMatches.filter(match => match.id !== exactMatch?.id)
  };
}

async function updateExistingContact(supabase: any, contactId: number, profileData: any, userId: string) {

  const updateData = buildUpdateData(profileData);

  // Update location
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
      // Restore old data on failure
      if (oldExp && oldExp.length > 0) {
        await supabase.from('contact_companies').insert(oldExp.map(({ id, ...rest }: any) => rest));
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
        await supabase.from('contact_schools').insert(oldEdu.map(({ id, ...rest }: any) => rest));
      }
      throw err;
    }
  }

  // Update tags
  const tags = profileData.suggested_tags || profileData.tags;
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, contactId, tags, userId);
  }

  return contact;
}

async function createNewContact(supabase: any, profileData: any, userId: string) {

  // Handle normalized location
  let locationId = null;
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

  // Create main contact
  const contactData = buildContactData(profileData, userId, locationId);

  const { data: contact, error: insertError } = await supabase
    .from('contacts')
    .insert(contactData)
    .select()
    .single();

  if (insertError || !contact) throw new Error(insertError?.message || 'Failed to create contact');

  // Add email if available
  if (profileData.contactInfo?.email) {
    await supabase
      .from('contact_emails')
      .insert({
        contact_id: contact.id,
        email: profileData.contactInfo.email,
        is_primary: true
      });
  }

  // Add experience
  if (profileData.experience && profileData.experience.length > 0) {
    await addExperienceToContact(supabase, contact.id, profileData.experience);
  }

  // Add education
  if (profileData.education && profileData.education.length > 0) {
    await addEducationToContact(supabase, contact.id, profileData.education);
  }

  // Add tags
  const tags = profileData.suggested_tags || profileData.tags;
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, contact.id, tags, userId);
  }

  return contact;
}


async function addExperienceToContact(supabase: any, contactId: number, experience: any[], skipDedup = false) {
  const validExps = experience.filter(exp => exp.company);
  if (validExps.length === 0) return;

  // Batch lookup: fetch matching companies concurrently (parameterized, handles special chars)
  const companyNames = [...new Set(validExps.map(exp => exp.company))];
  const companyResults = await Promise.all(
    companyNames.map(name =>
      supabase.from('companies').select('id, name').ilike('name', name).maybeSingle()
    )
  );

  // Build a case-insensitive lookup map
  const companyMap = new Map<string, { id: number; name: string }>();
  for (const { data } of companyResults) {
    if (data) companyMap.set(data.name.toLowerCase(), data);
  }

  // Create missing companies
  for (const name of companyNames) {
    if (!companyMap.has(name.toLowerCase())) {
      const { data: newCompany, error: insertErr } = await supabase
        .from('companies')
        .insert({ name })
        .select('id, name')
        .single();
      if (insertErr) {
        // Concurrent insert — re-fetch
        const { data: retry } = await supabase
          .from('companies')
          .select('id, name')
          .ilike('name', name)
          .maybeSingle();
        if (retry) companyMap.set(retry.name.toLowerCase(), retry);
      } else if (newCompany) {
        companyMap.set(newCompany.name.toLowerCase(), newCompany);
      }
    }
  }

  // Build insert list, skipping existing relationships unless we just deleted them
  let relSet = new Set<string>();
  if (!skipDedup) {
    const { data: existingRels } = await supabase
      .from('contact_companies')
      .select('company_id, title')
      .eq('contact_id', contactId);
    relSet = new Set((existingRels || []).map((r: any) =>
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

async function addEducationToContact(supabase: any, contactId: number, education: any[], skipDedup = false) {
  const validEdus = education.filter(edu => edu.school);
  if (validEdus.length === 0) return;

  // Batch lookup: fetch matching schools concurrently (parameterized, handles special chars)
  const schoolNames = [...new Set(validEdus.map(edu => edu.school))];
  const schoolResults = await Promise.all(
    schoolNames.map(name =>
      supabase.from('schools').select('id, name').ilike('name', name).maybeSingle()
    )
  );

  const schoolMap = new Map<string, { id: number; name: string }>();
  for (const { data } of schoolResults) {
    if (data) schoolMap.set(data.name.toLowerCase(), data);
  }

  // Create missing schools
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
        if (retry) schoolMap.set(retry.name.toLowerCase(), retry);
      } else if (newSchool) {
        schoolMap.set(newSchool.name.toLowerCase(), newSchool);
      }
    }
  }

  // Build insert list, skipping existing relationships unless we just deleted them
  let relSet = new Set<number>();
  if (!skipDedup) {
    const { data: existingRels } = await supabase
      .from('contact_schools')
      .select('school_id')
      .eq('contact_id', contactId);
    relSet = new Set((existingRels || []).map((r: any) => r.school_id));
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
    });
  }
  if (toInsert.length > 0) {
    await supabase.from('contact_schools').insert(toInsert);
  }
}

async function findOrCreateLocation(supabase: any, location: { city: string | null; state: string | null; country: string }) {
  function buildLookup() {
    let q = supabase.from('locations').select('id, city, state, country');
    q = location.city ? q.eq('city', location.city) : q.is('city', null);
    q = location.state ? q.eq('state', location.state) : q.is('state', null);
    return q.eq('country', location.country);
  }

  const { data: existing } = await buildLookup().maybeSingle();
  if (existing) return existing;

  // Create new; if concurrent insert, retry the lookup
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
    if (retry) return retry;
    throw error;
  }
  return data;
}

async function addTagsToContact(supabase: any, contactId: number, tags: string[], userId: string) {
  const normalizedTags = [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
  if (normalizedTags.length === 0) return;

  // Batch lookup: fetch user's existing tags in one query
  const { data: existingTags } = await supabase
    .from('tags')
    .select('id, name')
    .eq('user_id', userId);
  const tagMap = new Map<string, { id: number; name: string }>();
  for (const t of existingTags || []) {
    tagMap.set(t.name.toLowerCase(), t);
  }

  // Create missing tags
  for (const name of normalizedTags) {
    if (!tagMap.has(name)) {
      const { data: newTag } = await supabase
        .from('tags')
        .insert({ name, user_id: userId })
        .select('id, name')
        .single();
      if (newTag) tagMap.set(newTag.name.toLowerCase(), newTag);
    }
  }

  // Fetch existing contact-tag links in one query
  const tagIds = normalizedTags.map(n => tagMap.get(n)?.id).filter(Boolean) as number[];
  const { data: existingLinks } = await supabase
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .in('tag_id', tagIds);
  const linkedSet = new Set((existingLinks || []).map((r: any) => r.tag_id));

  // Batch insert missing links
  const toInsert = tagIds
    .filter(id => !linkedSet.has(id))
    .map(tag_id => ({ contact_id: contactId, tag_id }));
  if (toInsert.length > 0) {
    await supabase.from('contact_tags').insert(toInsert);
  }
}
