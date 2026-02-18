import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/calendar/events?start=...&end=...
 * Fetches calendar events from the local cache for a date range.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    const service = createSupabaseServiceClient();
    let query = service
      .from("calendar_events")
      .select("*")
      .eq("user_id", user.id)
      .order("start_at", { ascending: true });

    if (start) {
      query = query.gte("start_at", start);
    }
    if (end) {
      query = query.lte("start_at", end);
    }

    const { data, error } = await query;

    if (error) throw error;

    return NextResponse.json({ events: data || [] });
  } catch (error) {
    console.error("Error fetching events:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch events" },
      { status: 500 }
    );
  }
}
