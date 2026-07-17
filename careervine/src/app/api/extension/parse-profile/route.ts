// ── FIELD CONTRACT — shipped extensions call this; changes must be
// backward-compatible. Request body: `extensionParseProfileSchema`; the OpenAI
// structured-output schema (`parseProfileJsonSchema`) is a strict subset of the
// import wire's `profileDataSchema`, so parse output feeds import unchanged.
// Never rename a field on one side without the other (a parity test guards it).
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { runWithOpenAIFallback, DEFAULT_MODEL, AiUnavailableError } from "@/lib/openai";
import { extensionParseProfileSchema } from "@/lib/api-schemas";
import { parseProfileJsonSchema } from "@/lib/extension-contract";
import { addIsCurrentToExperience, addIsCurrentToEducation, deriveCurrentRole, deriveContactStatus } from '@/lib/profile-helpers';
import { handleOptions } from '@/lib/extension-auth';
import { wrapUntrusted, UNTRUSTED_DATA_CLAUSE } from '@/lib/ai/untrusted';

/**
 * API endpoint for parsing LinkedIn profile text using OpenAI
 * Receives cleaned text from Chrome extension, returns structured JSON
 */

export async function OPTIONS() {
  return handleOptions();
}

export const POST = withApiHandler({
  schema: extensionParseProfileSchema,
  extensionAuth: true,
  cors: true,
  // Bounds requests per user — every shared-key call spends real OpenAI money
  // (CAR-41). Single tier for everyone; shared-vs-BYO is decided inside
  // runWithOpenAIFallback and can flip mid-request, so it can't gate here.
  rateLimit: { bucket: "careervine-parse-profile", limit: 60, window: "1 h", failClosed: true },
  handler: async ({ user, body }) => {
    const { cleanedText, profileUrl } = body;

    const model = DEFAULT_MODEL;

    // OpenAI structured-output schema — single-sourced in extension-contract.ts
    // (kept a strict subset of the import wire's profileDataSchema).
    const linkedinProfileSchema = parseProfileJsonSchema;

    // Shorter instructions: rely on schema, keep only logic rules you truly need
    const instructions =
      "Extract the LinkedIn profile into the provided JSON schema. " +
      "generated_notes should be 2 or 3 short sentences about the person. " +
      "Return only valid JSON matching the schema. Prefer null when information is unclear or missing. " +
      "Industry should reflect the person's current or clearly intended industry based on the profile. " +
      "Extract EVERY position in the Experience section, not just the most recent one — include internships, part-time, and past roles. " +
      "When one company lists multiple roles (a company name followed by several titles and date ranges), output a separate experience entry for each role, each with that same company. " +
      "For current roles, set end_month to Present. " +
      "Extract EVERY school in the Education section. Set education end_year to the graduation year or expected graduation year, even when it is in the future (e.g. a current student graduating in 2028). " +
      "Extract a geographic job location for each experience if available (e.g., 'San Francisco, CA'). " +
      "Ignore work arrangement terms like remote, hybrid, internship, contract, freelance, part-time, full-time, temporary, or self-employed as locations.\n\n" +
      UNTRUSTED_DATA_CLAUSE;

    let response;
    try {
      response = await runWithOpenAIFallback(user.id, (openai) =>
        openai.responses.create({
          model,
          service_tier: "priority",
          instructions,
          // LinkedIn page text is attacker-authored — fence it (CAR-143)
          input: wrapUntrusted("linkedin_profile_text", cleanedText),
          max_output_tokens: 4000,
          text: {
            format: {
              type: "json_schema",
              ...linkedinProfileSchema
            }
          }
        }),
      );
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      console.error("[parse-profile] OpenAI API error:", err);
      throw new ApiError("Failed to parse profile. Please try again.", 500);
    }

    const responseText = response.output_text || '';

    // Check for empty response
    if (!responseText.trim()) {
      throw new ApiError(
        'OpenAI returned an empty response. The profile text may be too long or contain unsupported content. Please try again.',
        500
      );
    }

    // Parse the JSON response - with json_object mode, response should always be valid JSON
    let profileData;
    try {
      profileData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', responseText);
      console.error('Parse error:', parseError);
      throw new ApiError('Failed to parse profile data. Please try again.', 500);
    }

    // Algorithmic processing to derive missing fields

    // 1. Add is_current to experience and education based on end dates
    if (profileData.experience) {
      profileData.experience = addIsCurrentToExperience(profileData.experience);
    }

    if (profileData.education) {
      profileData.education = addIsCurrentToEducation(profileData.education);
    }

    // 2. Derive current_company and current_title from current experience
    const { current_company, current_title } = deriveCurrentRole(profileData.experience || []);
    profileData.current_company = current_company;
    profileData.current_title = current_title;

    // 3. Determine contact_status and expected_graduation from education
    const { contact_status, expected_graduation } = deriveContactStatus(profileData.education || []);
    profileData.contact_status = contact_status;
    profileData.expected_graduation = expected_graduation;

    // 4. Add empty fields for compatibility with existing code
    profileData.headline = null;
    profileData.about = null;

    // 5. Add the profile URL if provided
    if (profileUrl) {
      profileData.linkedin_url = profileUrl;
    }

    // 6. Construct the full name
    profileData.name = `${profileData.first_name || ''} ${profileData.last_name || ''}`.trim();

    return {
      success: true,
      profileData
    };
  },
});
