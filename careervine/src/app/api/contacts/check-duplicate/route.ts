import { NextRequest, NextResponse } from 'next/server';
import { calculateNameMatchConfidence } from '@/lib/duplicate-helpers';
import { sanitizeForPostgrest } from '@/lib/import-helpers';
import { corsHeaders, handleOptions, getExtensionAuth } from '@/lib/extension-auth';

export async function OPTIONS() {
  return handleOptions();
}

/**
 * API endpoint for checking potential duplicate contacts
 * Used by Chrome extension and webapp
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getExtensionAuth(request);
    if (auth.error) return auth.error;
    const { supabase, user } = auth;

    const { linkedinUrl, name, email } = await request.json();

    const duplicates = await findPotentialDuplicates(supabase, user.id, { linkedinUrl, name, email });

    return NextResponse.json({
      duplicates: duplicates.matches
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Duplicate check error:', error);
    return NextResponse.json({
      error: 'Duplicate check failed'
    }, { status: 500, headers: corsHeaders });
  }
}

async function findPotentialDuplicates(supabase: any, userId: string, searchData: { linkedinUrl?: string, name?: string, email?: string }) {
  const matches: any[] = [];

  // Check for exact LinkedIn URL match
  if (searchData.linkedinUrl) {
    const { data } = await supabase
      .from('contacts')
      .select('id, name, linkedin_url')
      .eq('user_id', userId)
      .eq('linkedin_url', searchData.linkedinUrl);

    if (data && data.length > 0) {
      matches.push(...data.map((contact: any) => ({
        ...contact,
        matchType: 'exact_linkedin',
        confidence: 100
      })));
    }
  }

  // Check for email match
  if (searchData.email && matches.length === 0) {
    const { data } = await supabase
      .from('contact_emails')
      .select(`
        contact_id,
        contacts!inner(id, name, linkedin_url)
      `)
      .eq('email', searchData.email)
      .eq('contacts.user_id', userId);

    if (data && data.length > 0) {
      matches.push(...data.map((item: any) => ({
        ...item.contacts,
        matchType: 'exact_email',
        confidence: 95
      })));
    }
  }

  // Check for name similarity
  if (searchData.name && matches.length === 0) {
    const names = searchData.name.split(' ').filter(n => n.length > 1);

    if (names.length >= 2) {
      const first = sanitizeForPostgrest(names[0]);
      const last = sanitizeForPostgrest(names[names.length - 1]);
      const { data } = await supabase
        .from('contacts')
        .select('id, name, linkedin_url')
        .eq('user_id', userId)
        .or(`name.ilike.%${first}%,name.ilike.%${last}%`);

      if (data && data.length > 0 && searchData.name) {
        data.filter((contact: any) => contact.name).forEach((contact: any) => {
          const confidence = calculateNameMatchConfidence(searchData.name!, contact.name as string);

          if (confidence > 50) {
            matches.push({
              ...contact,
              matchType: 'name_similarity',
              confidence
            });
          }
        });
      }
    }
  }

  // Sort by confidence
  matches.sort((a, b) => b.confidence - a.confidence);

  return { matches };
}

