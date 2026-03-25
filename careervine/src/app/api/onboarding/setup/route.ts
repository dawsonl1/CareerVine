import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ONBOARDING_CONTACT_EMAIL } from "@/components/onboarding/onboarding-steps";

/**
 * POST /api/onboarding/setup
 * Seeds the Dawson contact and creates the user_onboarding row.
 * Idempotent — safe to call multiple times.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    // Create onboarding row FIRST — the primary key on user_id prevents
    // duplicate inserts if two requests race past the status check.
    const { error: onboardingError } = await service.from("user_onboarding").insert({
      user_id: user.id,
      version: 1,
      current_step: "connect_gmail",
    });

    if (onboardingError) {
      // 23505 = unique_violation — another request already created the row
      if (onboardingError.code === "23505") {
        return { status: "already_setup" };
      }
      throw new Error(`Failed to create onboarding row: ${onboardingError.message}`);
    }

    // Create the Dawson contact
    const { data: contact, error: contactError } = await service
      .from("contacts")
      .insert({
        user_id: user.id,
        name: "Dawson Pitcher",
      })
      .select("id")
      .single();

    if (contactError || !contact) {
      throw new Error(`Failed to create Dawson contact: ${contactError?.message}`);
    }

    // Add primary email for the contact
    const { error: emailError } = await service.from("contact_emails").insert({
      contact_id: contact.id,
      email: ONBOARDING_CONTACT_EMAIL,
      is_primary: true,
    });

    if (emailError) {
      throw new Error(`Failed to create contact email: ${emailError.message}`);
    }

    return { status: "setup_complete", dawsonContactId: contact.id };
  },
});
