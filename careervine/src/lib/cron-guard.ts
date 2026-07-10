import { NextResponse } from "next/server";
import { trackCronError } from "@/lib/analytics/server";

/**
 * Wrap a QStash cron route's work so an uncaught crash emits the api_error
 * guardrail event (CAR-58). The cron routes run outside withApiHandler, so
 * without this a release that breaks one fails silently — no event, no
 * alerting surface, just missed sends.
 */
export async function withCronGuard(
  route: string,
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[${route}] cron run failed:`, err);
    await trackCronError(route);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
