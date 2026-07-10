import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerAllTools } from "@/mcp/register-tools";
import { initDb } from "@/mcp/lib/db";
import { runWithUserAsync } from "@/mcp/user-context";
import { verifyMcpToken } from "@/mcp/verify-token";
import { getMcpResourceUrl } from "@/mcp/auth-config";
import { checkRateLimit } from "@/lib/rate-limit";

// Service client singleton — user id comes from ALS per request.
initDb();

const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  { serverInfo: { name: "careervine", version: "1.0.0" } },
  { basePath: "/api", maxDuration: 60, disableSse: true },
);

const authedHandler = withMcpAuth(
  async (req) => {
    const userId = req.auth?.extra?.userId;
    if (typeof userId !== "string") {
      return mcpHandler(req);
    }
    const rate = await checkRateLimit(userId, {
      bucket: "careervine-mcp",
      limit: 100,
      window: "1 h",
    });
    if (!rate.allowed) {
      const retryAfterMs = Math.max(0, (rate.resetAt ?? Date.now()) - Date.now());
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
        },
      });
    }
    return runWithUserAsync(userId, () => mcpHandler(req));
  },
  verifyMcpToken,
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
    resourceUrl: getMcpResourceUrl(),
  },
);

export const GET = authedHandler;
export const POST = authedHandler;
export const DELETE = authedHandler;
export const maxDuration = 60;
