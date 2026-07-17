// ── FIELD CONTRACT — shipped extensions call this; changes must be
// backward-compatible. The body is empty (`extensionPingSchema`); the response
// is `{ ok: true }`. Installed extensions POST this right after login and on
// popup-open auth checks — do not add required request fields.
import { withApiHandler } from "@/lib/api-handler";
import { handleOptions } from "@/lib/extension-auth";
import { extensionPingSchema } from "@/lib/extension-contract";

export async function OPTIONS() {
  return handleOptions();
}

/**
 * CAR-68: extension liveness ping. The extension calls this right after login
 * (and on popup-open auth checks) so the onboarding "log in to the extension"
 * step advances immediately instead of waiting for the user's first scrape.
 * The api-handler's extensionAuth branch does the actual work — it stamps
 * users.extension_last_seen_at for every Bearer-authenticated call.
 */
export const POST = withApiHandler({
  schema: extensionPingSchema,
  extensionAuth: true,
  cors: true,
  handler: async () => ({ success: true }),
});
