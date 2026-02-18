import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/ai-write/resolve-contact?email=...
 * Resolves a recipient email to a contact ID.
 */
export async function GET(request: NextRequest) {
  try {
    const email = request.nextUrl.searchParams.get("email");
    if (!email) return NextResponse.json({ contactId: null });

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ contactId: null });

    const service = createSupabaseServiceClient();

    // Try contact_emails table first
    const { data: contactEmail } = await service
      .from("contact_emails")
      .select("contact_id, contacts!inner(user_id)")
      .eq("email", email.toLowerCase())
      .limit(1)
      .single();

    if (contactEmail) {
      // Verify ownership through the join
      const ce = contactEmail as unknown as { contact_id: number; contacts: { user_id: string } };
      if (ce.contacts?.user_id === user.id) {
        return NextResponse.json({ contactId: ce.contact_id });
      }
    }

    // Fallback: check email_messages for a matched contact
    const { data: emailMsg } = await service
      .from("email_messages")
      .select("matched_contact_id")
      .eq("user_id", user.id)
      .or(`from_address.eq.${email},to_addresses.cs.{${email}}`)
      .not("matched_contact_id", "is", null)
      .limit(1)
      .single();

    if (emailMsg?.matched_contact_id) {
      return NextResponse.json({ contactId: emailMsg.matched_contact_id });
    }

    return NextResponse.json({ contactId: null });
  } catch {
    return NextResponse.json({ contactId: null });
  }
}
