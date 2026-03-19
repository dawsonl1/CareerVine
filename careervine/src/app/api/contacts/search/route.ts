import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { escapeIlikePattern } from "@/lib/search-helpers";

/**
 * GET /api/contacts/search?q=...
 * Search contacts by name, return name + primary email for autocomplete.
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q")?.trim();
    if (!q || q.length < 1) return NextResponse.json({ contacts: [] });

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Sanitize input for PostgREST ilike filter
    const sanitized = escapeIlikePattern(q);

    // Use the authenticated client (RLS enforced) instead of service role
    const { data, error } = await supabase
      .from("contacts")
      .select("id, name, contact_emails(email, is_primary)")
      .ilike("name", `%${sanitized}%`)
      .limit(8);

    if (error) throw error;

    const results = (data || []).map((c) => {
      const emails = c.contact_emails as unknown as Array<{ email: string | null; is_primary: boolean }> | null;
      const allEmails = (emails || []).map((e) => e.email).filter(Boolean) as string[];
      const primary = emails?.find((e) => e.is_primary)?.email || allEmails[0] || null;
      return {
        id: c.id,
        name: c.name,
        email: primary,
        emails: allEmails,
      };
    }).filter((c) => c.email);

    return NextResponse.json({ contacts: results });
  } catch (error) {
    console.error("Contact search error:", error);
    return NextResponse.json({ contacts: [] }, { status: 500 });
  }
}
