import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/availability-profile
 * Saves availability profile (standard or priority) for the user.
 *
 * Body:
 * - profile: "standard" | "priority"
 * - data: { days, windowStart, windowEnd, duration, bufferBefore, bufferAfter }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { profile, data } = body;

    if (!profile || !data) {
      return NextResponse.json(
        { error: "Missing profile or data" },
        { status: 400 }
      );
    }

    const service = createSupabaseServiceClient();
    const updateData = profile === "standard"
      ? { availability_standard: data }
      : { availability_priority: data };

    const { error } = await service
      .from("gmail_connections")
      .update(updateData)
      .eq("user_id", user.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Availability profile error:", error);
    return NextResponse.json(
      { error: "Failed to save availability profile" },
      { status: 500 }
    );
  }
}
