import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailAiWriteSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";

/**
 * POST /api/gmail/ai-write
 * Generate an email using AI with contact context and optional meeting notes.
 */
export const POST = withApiHandler({
  schema: gmailAiWriteSchema,
  handler: async ({ user, body }) => {
    const { prompt, contactId, meetingIds, additionalContext, subject } = body;

    const service = createSupabaseServiceClient();

    // ── Gather context ──

    // 1. User's own profile
    const { data: userProfile } = await service
      .from("users")
      .select("first_name, last_name, email")
      .eq("id", user.id)
      .single();

    const senderName = userProfile
      ? `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim()
      : "";

    // 2. Contact info (if contactId provided)
    let contactContext = "";
    if (contactId) {
      const { data: contact } = await service
        .from("contacts")
        .select(`
          name, industry, notes, met_through, contact_status, expected_graduation,
          locations(city, state, country),
          contact_emails(email),
          contact_companies(
            title, is_current,
            companies(name)
          ),
          contact_schools(
            degree, field_of_study, start_year, end_year,
            schools(name)
          )
        `)
        .eq("id", contactId)
        .single();

      if (contact) {
        const parts: string[] = [];
        parts.push(`Name: ${contact.name}`);
        if (contact.industry) parts.push(`Industry: ${contact.industry}`);
        if (contact.contact_status) parts.push(`Status: ${contact.contact_status}`);
        if (contact.expected_graduation) parts.push(`Expected graduation: ${contact.expected_graduation}`);
        if (contact.met_through) parts.push(`Met through: ${contact.met_through}`);
        if (contact.notes) parts.push(`Notes: ${contact.notes}`);

        // Location
        const loc = contact.locations as unknown as { city: string | null; state: string | null; country: string } | null;
        if (loc) {
          const locParts = [loc.city, loc.state, loc.country].filter(Boolean);
          if (locParts.length) parts.push(`Location: ${locParts.join(", ")}`);
        }

        // Companies
        const companies = contact.contact_companies as unknown as Array<{
          title: string | null;
          is_current: boolean;
          companies: { name: string } | null;
        }> | null;
        if (companies?.length) {
          const compStrs = companies.map((cc) => {
            const name = cc.companies?.name || "Unknown";
            return cc.is_current
              ? `${cc.title || "Role"} at ${name} (current)`
              : `${cc.title || "Role"} at ${name}`;
          });
          parts.push(`Work experience: ${compStrs.join("; ")}`);
        }

        // Schools
        const schools = contact.contact_schools as unknown as Array<{
          degree: string | null;
          field_of_study: string | null;
          start_year: number | null;
          end_year: number | null;
          schools: { name: string } | null;
        }> | null;
        if (schools?.length) {
          const eduStrs = schools.map((cs) => {
            const name = cs.schools?.name || "Unknown";
            const deg = [cs.degree, cs.field_of_study].filter(Boolean).join(" in ");
            const years = [cs.start_year, cs.end_year].filter(Boolean).join("–");
            const base = deg ? `${deg} from ${name}` : name;
            return years ? `${base} (${years})` : base;
          });
          parts.push(`Education: ${eduStrs.join("; ")}`);
        }

        // Emails
        const emails = contact.contact_emails as Array<{ email: string }> | null;
        if (emails?.length) {
          parts.push(`Email(s): ${emails.map((e) => e.email).join(", ")}`);
        }

        contactContext = parts.join("\n");
      }
    }

    // 3. Meeting notes/transcripts (if meetingIds provided)
    let meetingContext = "";
    if (meetingIds?.length) {
      const { data: meetings } = await service
        .from("meetings")
        .select("id, meeting_date, meeting_type, notes, transcript")
        .in("id", meetingIds)
        .eq("user_id", user.id)
        .order("meeting_date", { ascending: false });

      if (meetings?.length) {
        const meetingParts = meetings.map((m) => {
          const parts: string[] = [];
          parts.push(`Meeting on ${new Date(m.meeting_date).toLocaleDateString()} (${m.meeting_type})`);
          if (m.notes) parts.push(`Notes: ${m.notes}`);
          if (m.transcript) parts.push(`Transcript: ${m.transcript.substring(0, 3000)}`);
          return parts.join("\n");
        });
        meetingContext = meetingParts.join("\n\n");
      }
    }

    // ── Build the AI prompt ──

    const systemPrompt = `You are an expert email writer helping a professional craft personalized emails.
Write the email body only — do NOT include a subject line, greeting preamble like "Subject:", or sign-off signature.
Start directly with the greeting (e.g., "Hi [Name],") and end just before where a signature would go.
Write in a natural, professional tone. Be concise but warm. Avoid being overly formal or stiff.
Use the contact's information to personalize the email meaningfully — reference their work, background, shared connections, or recent meetings where relevant.
Output clean HTML suitable for an email body (use <p> tags for paragraphs, <br> for line breaks within paragraphs). Do not use markdown.`;

    const userParts: string[] = [];
    userParts.push(`EMAIL TYPE/INSTRUCTIONS: ${prompt}`);

    if (senderName) userParts.push(`\nSENDER: ${senderName} (${userProfile?.email || ""})`);

    if (contactContext) userParts.push(`\nRECIPIENT INFORMATION:\n${contactContext}`);

    if (meetingContext) userParts.push(`\nMEETING NOTES/TRANSCRIPTS:\n${meetingContext}`);

    if (subject) userParts.push(`\nEXISTING SUBJECT LINE: ${subject}`);

    if (additionalContext) userParts.push(`\nADDITIONAL CONTEXT FROM USER: ${additionalContext}`);

    // ── Call OpenAI ──

    const openai = getOpenAIClient();
    const model = DEFAULT_MODEL;

    let response;
    try {
      response = await openai.responses.create({
        model,
        instructions: systemPrompt,
        input: userParts.join("\n"),
        max_output_tokens: 2000,
      });
    } catch (err) {
      console.error("[ai-write] OpenAI API error:", err);
      throw new ApiError("Failed to generate email. Please try again.", 500);
    }

    const emailHtml = response.output_text || "";

    if (!emailHtml.trim()) {
      throw new ApiError("AI returned an empty response. Please try again.", 500);
    }

    // Also generate a subject line if none provided
    let generatedSubject: string | null = null;
    if (!subject) {
      try {
        const subjectResponse = await openai.responses.create({
          model,
          instructions: "Generate a concise, professional email subject line for the following email. Return ONLY the subject line text, nothing else. No quotes.",
          input: emailHtml,
          max_output_tokens: 100,
        });
        generatedSubject = subjectResponse.output_text?.trim() || null;
      } catch {
        // Subject generation is best-effort; use null if it fails
      }
    }

    return {
      success: true,
      bodyHtml: emailHtml,
      subject: generatedSubject,
    };
  },
});
