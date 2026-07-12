import { withApiHandler } from "@/lib/api-handler";
import { resolveCapabilities } from "@/lib/capabilities";

/**
 * GET /api/capabilities
 *
 * The client mirror of the server capability resolver (CAR-103). The entitlement
 * flags are service-role-only (CAR-27 column lock) and unreadable by the browser
 * client, so we resolve the capability set server-side and ship it as a plain
 * string array. The client never re-derives tier logic — it just asks
 * `can(capability)`.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const capabilities = await resolveCapabilities(user.id);
    return { capabilities: Array.from(capabilities) };
  },
});
