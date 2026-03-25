import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/onboarding/setup
 * Seeds the Dawson contact and creates the user_onboarding row.
 * Idempotent — safe to call multiple times.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    // Idempotency check — if onboarding row already exists, return early
    const { data: existing } = await service
      .from("user_onboarding")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (existing) {
      return { status: "already_setup" };
    }

    // Create the Dawson contact
    const { data: contact, error: contactError } = await service
      .from("contacts")
      .insert({
        user_id: user.id,
        first_name: "Dawson",
        last_name: "Pitcher",
        company: "Deloitte",
        title: "Senior Business Analyst",
      })
      .select("id")
      .single();

    if (contactError || !contact) {
      throw new Error(`Failed to create Dawson contact: ${contactError?.message}`);
    }

    // Add primary email for the contact
    const { error: emailError } = await service.from("contact_emails").insert({
      contact_id: contact.id,
      email: "dawson@careervine.app",
      is_primary: true,
    });

    if (emailError) {
      throw new Error(`Failed to create contact email: ${emailError.message}`);
    }

    // Create the onboarding row
    const { error: onboardingError } = await service.from("user_onboarding").insert({
      user_id: user.id,
      version: 1,
      current_step: "connect_gmail",
    });

    if (onboardingError) {
      throw new Error(`Failed to create onboarding row: ${onboardingError.message}`);
    }

    return { status: "setup_complete", dawsonContactId: contact.id };
  },
});
