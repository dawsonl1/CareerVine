import { withApiHandler } from "@/lib/api-handler";
import { contactsCheckDuplicateSchema } from "@/lib/api-schemas";
import { calculateNameMatchConfidence } from '@/lib/duplicate-helpers';
import { sanitizeForPostgrest } from '@/lib/import-helpers';
import { handleOptions } from '@/lib/extension-auth';
import { shouldRederiveStatus, deriveContactStatusFromDB } from '@/lib/profile-helpers';

export async function OPTIONS() {
  return handleOptions();
}

/**
 * API endpoint for checking potential duplicate contacts
 * Used by Chrome extension and webapp
 */
export const POST = withApiHandler({
  schema: contactsCheckDuplicateSchema,
  extensionAuth: true,
  cors: true,
  handler: async ({ supabase, user, body }) => {
    const { linkedinUrl, name, email } = body;

    const duplicates = await findPotentialDuplicates(supabase, user.id, { linkedinUrl, name, email });

    // Lazy re-derivation: batch-check stale matches and update in bulk
    const staleIds = duplicates.matches
      .filter(m => shouldRederiveStatus(m.status_derived_at))
      .map(m => m.id);

    if (staleIds.length > 0) {
      const { data: allEducation } = await supabase
        .from('contact_schools')
        .select('contact_id, end_year')
        .in('contact_id', staleIds);

      const eduByContact = new Map<number, { end_year: number | null }[]>();
      for (const row of allEducation ?? []) {
        const list = eduByContact.get(row.contact_id) ?? [];
        list.push({ end_year: row.end_year });
        eduByContact.set(row.contact_id, list);
      }

      const now = new Date().toISOString();
      for (const id of staleIds) {
        const edu = eduByContact.get(id);
        if (edu && edu.length > 0) {
          const derived = deriveContactStatusFromDB(edu);
          await supabase
            .from('contacts')
            .update({
              contact_status: derived.contact_status,
              expected_graduation: derived.expected_graduation,
              status_derived_at: now,
            })
            .eq('id', id);
          const match = duplicates.matches.find(m => m.id === id);
          if (match) match.contact_status = derived.contact_status;
        } else {
          await supabase
            .from('contacts')
            .update({ status_derived_at: now })
            .eq('id', id);
        }
      }
    }

    return {
      duplicates: duplicates.matches
    };
  },
});

async function findPotentialDuplicates(supabase: any, userId: string, searchData: { linkedinUrl?: string, name?: string, email?: string }) {
  const matches: any[] = [];

  // Check for exact LinkedIn URL match
  if (searchData.linkedinUrl) {
    const { data } = await supabase
      .from('contacts')
      .select('id, name, linkedin_url, contact_status, status_derived_at, industry, notes')
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
        contacts!inner(id, name, linkedin_url, contact_status, status_derived_at, industry, notes)
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
        .select('id, name, linkedin_url, contact_status, status_derived_at, industry, notes')
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
