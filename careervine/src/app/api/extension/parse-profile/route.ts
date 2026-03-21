import { withApiHandler, ApiError } from "@/lib/api-handler";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { extensionParseProfileSchema } from "@/lib/api-schemas";
import { addIsCurrentToExperience, addIsCurrentToEducation, deriveCurrentRole, deriveContactStatus } from '@/lib/profile-helpers';
import { handleOptions } from '@/lib/extension-auth';

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
  handler: async ({ body }) => {
    const { cleanedText, profileUrl } = body;

    const openai = getOpenAIClient();
    const model = DEFAULT_MODEL;

    // Optimized schema - only request what we actually need from AI
    const linkedinProfileSchema = {
      name: "linkedin_profile",
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "first_name",
          "last_name",
          "location",
          "industry",
          "generated_notes",
          "suggested_tags",
          "experience",
          "education"
        ],
        properties: {
          first_name: { type: "string", maxLength: 40 },
          last_name: { type: "string", maxLength: 60 },
          location: {
            type: "object",
            additionalProperties: false,
            required: ["city", "state", "country"],
            properties: {
              city: { type: ["string", "null"], maxLength: 60 },
              state: { type: ["string", "null"], maxLength: 60 },
              country: { type: "string", default: "United States", maxLength: 60 }
            }
          },
          industry: { type: ["string", "null"], maxLength: 60 },
          generated_notes: { type: "string", maxLength: 420 },
          suggested_tags: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            items: { type: "string", maxLength: 32 }
          },
          experience: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "company",
                "title",
                "location",
                "start_month",
                "end_month"
              ],
              properties: {
                company: { type: "string", maxLength: 120 },
                title: { type: "string", maxLength: 120 },
                location: { type: ["string", "null"], maxLength: 120 },
                start_month: { type: ["string", "null"], maxLength: 12 },
                end_month: { type: ["string", "null"], maxLength: 12 }
              }
            }
          },
          education: {
            type: "array",
            maxItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "school",
                "degree",
                "field_of_study",
                "start_year",
                "end_year"
              ],
              properties: {
                school: { type: "string", maxLength: 140 },
                degree: {
                  type: ["string", "null"],
                  enum: [null, "Bachelor's", "Master's", "PhD", "Associate's", "Certificate", "Diploma"]
                },
                field_of_study: { type: ["string", "null"], maxLength: 80 },
                start_year: { type: ["string", "null"], maxLength: 10 },
                end_year: { type: ["string", "null"], maxLength: 10 }
              }
            }
          }
        }
      },
      strict: true
    };

    // Shorter instructions: rely on schema, keep only logic rules you truly need
    const instructions =
      "Extract the LinkedIn profile into the provided JSON schema. " +
      "generated_notes should be 2 or 3 short sentences about the person. " +
      "Return only valid JSON matching the schema. Prefer null when information is unclear or missing. " +
      "Industry should reflect the person's current or clearly intended industry based on the profile. " +
      "For current roles, set end_month to Present. " +
      "Extract a geographic job location for each experience if available (e.g., 'San Francisco, CA'). " +
      "Ignore work arrangement terms like remote, hybrid, internship, contract, freelance, part-time, full-time, temporary, or self-employed as locations. ";

    let response;
    try {
      response = await openai.responses.create({
        model,
        service_tier: "priority",
        instructions,
        input: cleanedText,
        max_output_tokens: 4000,
        text: {
          format: {
            type: "json_schema",
            ...linkedinProfileSchema
          }
        }
      });
    } catch (err) {
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
