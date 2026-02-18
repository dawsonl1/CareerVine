import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

// Built-in preset templates (returned when user has no custom ones)
const PRESET_TEMPLATES = [
  {
    name: "Introduction",
    prompt: "Write a professional introduction email. Introduce yourself, mention any shared connections or interests, and express interest in connecting.",
    sort_order: 0,
  },
  {
    name: "Follow-up after meeting",
    prompt: "Write a follow-up email after a recent meeting. Reference specific topics discussed, express appreciation for their time, and suggest next steps.",
    sort_order: 1,
  },
  {
    name: "Thank you",
    prompt: "Write a thoughtful thank-you email. Be specific about what you're grateful for and mention any impact it had.",
    sort_order: 2,
  },
  {
    name: "Networking request",
    prompt: "Write an email requesting a networking conversation. Be respectful of their time, mention why you'd like to connect, and suggest a brief call or coffee.",
    sort_order: 3,
  },
  {
    name: "Informational interview",
    prompt: "Write an email requesting an informational interview. Show genuine interest in their career path, mention specific aspects of their work that interest you, and propose a short 20-minute call.",
    sort_order: 4,
  },
  {
    name: "Check-in",
    prompt: "Write a casual check-in email. Keep it warm and personal, reference your last interaction, and show genuine interest in how they're doing.",
    sort_order: 5,
  },
];

/**
 * GET /api/gmail/templates
 * Returns user's custom templates, or preset defaults if they have none.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ templates: [], presets: PRESET_TEMPLATES });

    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("email_templates")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    return NextResponse.json({
      templates: data || [],
      presets: PRESET_TEMPLATES,
    });
  } catch (error) {
    console.error("Templates fetch error:", error);
    return NextResponse.json({ templates: [], presets: PRESET_TEMPLATES });
  }
}

/**
 * POST /api/gmail/templates
 * Create or update a template.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const service = createSupabaseServiceClient();

    if (body.id) {
      const { data, error } = await service
        .from("email_templates")
        .update({
          name: body.name,
          prompt: body.prompt,
          sort_order: body.sort_order ?? 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, template: data });
    } else {
      const { data, error } = await service
        .from("email_templates")
        .insert({
          user_id: user.id,
          name: body.name,
          prompt: body.prompt,
          is_default: false,
          sort_order: body.sort_order ?? 0,
        })
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, template: data });
    }
  } catch (error) {
    console.error("Template save error:", error);
    return NextResponse.json({ error: "Failed to save template" }, { status: 500 });
  }
}
