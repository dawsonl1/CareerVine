import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server-client';
import OpenAI from 'openai';

/**
 * API endpoint for parsing LinkedIn profile text using OpenAI
 * Receives cleaned text from Chrome extension, returns structured JSON
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

    const { cleanedText, profileUrl } = await request.json();

    if (!cleanedText) {
      return NextResponse.json({ error: 'No profile text provided' }, { status: 400, headers: corsHeaders });
    }

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Parse the LinkedIn text using the new Responses API with structured JSON output
    const model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
    
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

    const response = await openai.responses.create({
      model,
      service_tier: "priority", // Use default speed for balanced performance
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

        // 1) Debug once to see what you actually got back
      const { model: responseModel, service_tier, usage } = response;

      console.log(
        JSON.stringify(
          {
            id: response.id,
            status: response.status,
            model_used: responseModel,
            service_tier,
            usage,
            output_len: response.output?.length ?? 0,
            output_text_len: (response.output_text ?? "").length
          },
          null,
          2
        )
      );

      console.dir(
        response
      )

    const responseText = response.output_text || '';
    
    // Check for empty response
    if (!responseText.trim()) {
      console.error('OpenAI returned empty response');
      return NextResponse.json({ 
        error: 'OpenAI returned an empty response. The profile text may be too long or contain unsupported content. Please try again.'
      }, { status: 500, headers: corsHeaders });
    }
    
    // Parse the JSON response - with json_object mode, response should always be valid JSON
    let profileData;
    try {
      profileData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', responseText);
      console.error('Parse error:', parseError);
      return NextResponse.json({ 
        error: `Failed to parse profile data. Raw response: ${responseText.substring(0, 500)}`,
        rawResponse: responseText 
      }, { status: 500, headers: corsHeaders });
    }

    // Algorithmic processing to derive missing fields
    
    // 1. Add is_current to experience and education based on end dates
    if (profileData.experience) {
      profileData.experience = profileData.experience.map((exp: any) => ({
        ...exp,
        is_current: exp.end_month === "Present"
      }));
    }
    
    if (profileData.education) {
      profileData.education = profileData.education.map((edu: any) => ({
        ...edu,
        is_current: edu.end_year === "Present"
      }));
    }

    // 2. Derive current_company and current_title from current experience
    const currentExperience = profileData.experience?.find((exp: any) => exp.is_current);
    profileData.current_company = currentExperience?.company || null;
    profileData.current_title = currentExperience?.title || null;

    // 3. Determine contact_status and expected_graduation from education
    const currentYear = new Date().getFullYear();
    const hasCurrentEducation = profileData.education?.some((edu: any) => edu.is_current);
    const futureGraduation = profileData.education?.find((edu: any) => {
      const endYear = parseInt(edu.end_year);
      return endYear && endYear > currentYear;
    });
    
    if (hasCurrentEducation || futureGraduation) {
      profileData.contact_status = "student";
      profileData.expected_graduation = futureGraduation?.end_year || null;
    } else {
      profileData.contact_status = "professional";
      profileData.expected_graduation = null;
    }

    // 4. Add empty fields for compatibility with existing code
    profileData.headline = null;
    profileData.about = null;

    // 5. Add the profile URL if provided
    if (profileUrl) {
      profileData.linkedin_url = profileUrl;
    }

    // 6. Construct the full name
    profileData.name = `${profileData.first_name || ''} ${profileData.last_name || ''}`.trim();

    return NextResponse.json({ 
      success: true, 
      profileData 
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Parse profile error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to parse profile';
    const errorDetails = error instanceof Error && 'response' in error ? JSON.stringify((error as any).response?.data) : '';
    return NextResponse.json({ 
      error: `${errorMessage}${errorDetails ? ` - ${errorDetails}` : ''}` 
    }, { status: 500, headers: corsHeaders });
  }
}
