import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server-client';
import { parseFollowUpFrequency, sanitizeForPostgrest, buildUpdateData } from '@/lib/import-helpers';

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
      const { url, anonKey } = getSupabaseEnv({ server: true });
      
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
      error: error instanceof Error ? error.message : 'Import failed' 
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

  // Clear existing experience/education before re-adding to prevent duplicates
  if (profileData.experience && profileData.experience.length > 0) {
    await supabase.from('contact_companies').delete().eq('contact_id', contactId);
    await addExperienceToContact(supabase, contactId, profileData.experience);
  }

  if (profileData.education && profileData.education.length > 0) {
    await supabase.from('contact_schools').delete().eq('contact_id', contactId);
    await addEducationToContact(supabase, contactId, profileData.education);
  }

  // Update tags
  const tags = profileData.suggested_tags || profileData.tags;
  if (tags && tags.length > 0) {
    await addTagsToContact(supabase, contactId, tags, userId);
  }

  return contact;
}

async function createNewContact(supabase: any, profileData: any, userId: string) {
  
  // Use AI-generated notes if provided
  let notes = profileData.generated_notes || profileData.notes || null;
  if (!notes) {
    notes = `Imported from LinkedIn on ${new Date().toLocaleDateString()}`;
  }

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
  const contactData: any = {
    user_id: userId,
    name: profileData.name || 'Unknown',
    linkedin_url: profileData.linkedin_url || profileData.profileUrl || null,
    industry: profileData.industry || null,
    location_id: locationId,
    notes: notes,
    contact_status: profileData.contact_status || 'professional',
    expected_graduation: profileData.expected_graduation || null,
    follow_up_frequency_days: parseFollowUpFrequency(profileData.follow_up_frequency) ?? (profileData.follow_up_frequency_days || null)
  };

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


async function addExperienceToContact(supabase: any, contactId: number, experience: any[]) {
  for (const exp of experience) {
    if (!exp.company) continue;

    // Find or create company (upsert-style to avoid race conditions)
    let company;
    const { data: existingCompany } = await supabase
      .from('companies')
      .select('id, name')
      .ilike('name', exp.company)
      .maybeSingle();

    if (existingCompany) {
      company = existingCompany;
    } else {
      // Try insert; if another request created it concurrently, fetch it
      const { data: newCompany, error: insertErr } = await supabase
        .from('companies')
        .insert({ name: exp.company })
        .select()
        .single();
      if (insertErr) {
        const { data: retry } = await supabase
          .from('companies')
          .select('id, name')
          .ilike('name', exp.company)
          .maybeSingle();
        company = retry;
      } else {
        company = newCompany;
      }
    }
    if (!company) continue;

    // Skip if this exact relationship already exists
    const { data: existingRel } = await supabase
      .from('contact_companies')
      .select('id')
      .eq('contact_id', contactId)
      .eq('company_id', company.id)
      .eq('title', exp.title || null)
      .maybeSingle();

    if (!existingRel) {
      await supabase
        .from('contact_companies')
        .insert({
          contact_id: contactId,
          company_id: company.id,
          title: exp.title || null,
          start_month: exp.start_month || null,
          end_month: exp.is_current ? 'Present' : (exp.end_month || null),
          is_current: exp.is_current || false
        });
    }
  }
}

async function addEducationToContact(supabase: any, contactId: number, education: any[]) {
  for (const edu of education) {
    if (!edu.school) continue;

    // Find or create school (upsert-style to avoid race conditions)
    let school;
    const { data: existingSchool } = await supabase
      .from('schools')
      .select('id, name')
      .ilike('name', edu.school)
      .maybeSingle();

    if (existingSchool) {
      school = existingSchool;
    } else {
      const { data: newSchool, error: insertErr } = await supabase
        .from('schools')
        .insert({ name: edu.school })
        .select()
        .single();
      if (insertErr) {
        const { data: retry } = await supabase
          .from('schools')
          .select('id, name')
          .ilike('name', edu.school)
          .maybeSingle();
        school = retry;
      } else {
        school = newSchool;
      }
    }
    if (!school) continue;

    // Skip if this exact relationship already exists
    const { data: existingRel } = await supabase
      .from('contact_schools')
      .select('id')
      .eq('contact_id', contactId)
      .eq('school_id', school.id)
      .maybeSingle();

    if (!existingRel) {
      await supabase
        .from('contact_schools')
        .insert({
          contact_id: contactId,
          school_id: school.id,
          degree: edu.degree || null,
          field_of_study: edu.field_of_study || null
        });
    }
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
  
  for (const tagName of tags) {
    if (!tagName.trim()) continue;
    
    const normalizedTag = tagName.trim().toLowerCase();
    
    // Find or create tag
    let tag;
    const { data: existingTag } = await supabase
      .from('tags')
      .select('id, name')
      .eq('user_id', userId)
      .ilike('name', normalizedTag)
      .maybeSingle();

    if (existingTag) {
      tag = existingTag;
    } else {
      const { data: newTag } = await supabase
        .from('tags')
        .insert({ name: normalizedTag, user_id: userId })
        .select()
        .single();
      tag = newTag;
    }

    if (tag) {
      // Check if contact-tag link already exists
      const { data: existingLink } = await supabase
        .from('contact_tags')
        .select('id')
        .eq('contact_id', contactId)
        .eq('tag_id', tag.id)
        .maybeSingle();

      if (!existingLink) {
        await supabase
          .from('contact_tags')
          .insert({
            contact_id: contactId,
            tag_id: tag.id
          });
      }
    }
  }
}
