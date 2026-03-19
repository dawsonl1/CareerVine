import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server-client';
import { createContact, getContacts } from '@/lib/queries';

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
    const duplicates = await findDuplicateContacts(user.id, profileData);
    
    let contact;
    let isUpdate = false;

    if (duplicates.exactMatch) {
      // Update existing contact
      contact = await updateExistingContact(duplicates.exactMatch.id, profileData, user.id);
      isUpdate = true;
    } else if (duplicates.potentialMatches.length > 0) {
      // Create new contact but mark potential matches
      contact = await createNewContact(profileData, user.id);
      // TODO: You might want to notify user about potential matches
    } else {
      // Create completely new contact
      contact = await createNewContact(profileData, user.id);
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

async function findDuplicateContacts(userId: string, profileData: any) {
  const supabase = await createSupabaseServerClient();
  
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
      const firstName = names[0];
      const lastName = names[names.length - 1];
      
      // Search for contacts with similar names
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

async function updateExistingContact(contactId: number, profileData: any, userId: string) {
  const supabase = await createSupabaseServerClient();
  
  // Update main contact info
  const updateData: any = {
    updated_at: new Date().toISOString()
  };

  if (profileData.headline) {
    updateData.industry = profileData.headline;
  }

  if (profileData.location) {
    updateData.notes = profileData.location;
  }

  const { data: contact } = await supabase
    .from('contacts')
    .update(updateData)
    .eq('id', contactId)
    .eq('user_id', userId)
    .select()
    .single();

  // Add new experience if available
  if (profileData.experience && profileData.experience.length > 0) {
    await addExperienceToContact(contactId, profileData.experience, userId);
  }

  // Add new education if available
  if (profileData.education && profileData.education.length > 0) {
    await addEducationToContact(contactId, profileData.education, userId);
  }

  return contact;
}

async function createNewContact(profileData: any, userId: string) {
  const supabase = await createSupabaseServerClient();
  
  // Use AI-generated notes if provided, otherwise build from headline/about
  let notes = profileData.notes || null;
  if (!notes) {
    const noteParts = [`Imported from LinkedIn on ${new Date().toLocaleDateString()}`];
    notes = noteParts.join('');
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
    linkedin_url: profileData.profileUrl || null,
    industry: profileData.industry || null,
    location_id: locationId,
    notes: notes,
    contact_status: profileData.contact_status || 'professional',
    expected_graduation: profileData.expected_graduation || null,
    follow_up_frequency_days: profileData.follow_up_frequency_days || null
  };

  const { data: contact } = await supabase
    .from('contacts')
    .insert(contactData)
    .select()
    .single();

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
    await addExperienceToContact(contact.id, profileData.experience, userId);
  }

  // Add education
  if (profileData.education && profileData.education.length > 0) {
    await addEducationToContact(contact.id, profileData.education, userId);
  }

  // Add tags
  if (profileData.tags && profileData.tags.length > 0) {
    await addTagsToContact(contact.id, profileData.tags, userId);
  }

  return contact;
}

async function addExperienceToContact(contactId: number, experience: any[], userId: string) {
  const supabase = await createSupabaseServerClient();
  
  for (const exp of experience) {
    if (!exp.company) continue;

    // Find or create company
    let company;
    const { data: existingCompany } = await supabase
      .from('companies')
      .select('*')
      .ilike('name', exp.company)
      .single();

    if (existingCompany) {
      company = existingCompany;
    } else {
      const { data: newCompany } = await supabase
        .from('companies')
        .insert({ name: exp.company })
        .select()
        .single();
      company = newCompany;
    }

    // Add contact-company relationship with timeline
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

async function addEducationToContact(contactId: number, education: any[], userId: string) {
  const supabase = await createSupabaseServerClient();
  
  for (const edu of education) {
    if (!edu.school) continue;

    // Find or create school
    let school;
    const { data: existingSchool } = await supabase
      .from('schools')
      .select('*')
      .ilike('name', edu.school)
      .single();

    if (existingSchool) {
      school = existingSchool;
    } else {
      const { data: newSchool } = await supabase
        .from('schools')
        .insert({ name: edu.school })
        .select()
        .single();
      school = newSchool;
    }

    // Add contact-school relationship
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

async function findOrCreateLocation(supabase: any, location: { city: string | null; state: string | null; country: string }) {
  // Try to find existing with exact match
  let query = supabase.from('locations').select('*');
  
  if (location.city) {
    query = query.eq('city', location.city);
  } else {
    query = query.is('city', null);
  }
  
  if (location.state) {
    query = query.eq('state', location.state);
  } else {
    query = query.is('state', null);
  }
  
  query = query.eq('country', location.country);
  
  const { data: existing } = await query.maybeSingle();
  if (existing) return existing;

  // Create new
  const { data, error } = await supabase
    .from('locations')
    .insert({
      city: location.city,
      state: location.state,
      country: location.country,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function addTagsToContact(contactId: number, tags: string[], userId: string) {
  const supabase = await createSupabaseServerClient();
  
  for (const tagName of tags) {
    if (!tagName.trim()) continue;
    
    const normalizedTag = tagName.trim().toLowerCase();
    
    // Find or create tag
    let tag;
    const { data: existingTag } = await supabase
      .from('tags')
      .select('*')
      .eq('user_id', userId)
      .ilike('name', normalizedTag)
      .single();

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
        .select('*')
        .eq('contact_id', contactId)
        .eq('tag_id', tag.id)
        .single();

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
