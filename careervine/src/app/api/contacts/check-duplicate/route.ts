import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server-client';
import { calculateNameMatchConfidence } from '@/lib/duplicate-helpers';
import { sanitizeForPostgrest } from '@/lib/import-helpers';

// CORS headers for Chrome extension
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * API endpoint for checking potential duplicate contacts
 * Used by Chrome extension and webapp
 */
export async function POST(request: NextRequest) {
  try {
    // Support both cookie auth (webapp) and Bearer token auth (extension)
    const authHeader = request.headers.get('authorization');
    let supabase;
    let user;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const { createClient } = await import('@supabase/supabase-js');
      const { getSupabaseEnv } = await import('@/lib/supabase/config');
      const { url, anonKey } = getSupabaseEnv({ server: true });
      supabase = createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }
      user = data.user;
    } else {
      supabase = await createSupabaseServerClient();
      const { data, error: authError } = await supabase.auth.getUser();
      if (!data.user || authError) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }
      user = data.user;
    }

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
  const matches = [];

  // Check for exact LinkedIn URL match
  if (searchData.linkedinUrl) {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('linkedin_url', searchData.linkedinUrl);

    if (data && data.length > 0) {
      matches.push(...data.map(contact => ({
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
        *,
        contacts!inner(*)
      `)
      .eq('email', searchData.email)
      .eq('contacts.user_id', userId);

    if (data && data.length > 0) {
      matches.push(...data.map(item => ({
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
      // Sanitize for PostgREST filter syntax
      const first = sanitizeForPostgrest(names[0]);
      const last = sanitizeForPostgrest(names[names.length - 1]);
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', userId)
        .or(`name.ilike.%${first}%,name.ilike.%${last}%`);

      if (data && data.length > 0 && searchData.name) {
        data.filter(contact => contact.name).forEach(contact => {
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

