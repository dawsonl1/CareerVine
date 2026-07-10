/**
 * CareerVine MCP server (plan 26).
 *
 * Local stdio server that turns Claude Code into a command-line operator
 * for CareerVine: research contacts, draft/send grounded emails, run the
 * outreach queue, log interactions, manage action items, pull company
 * intel, and work the calendar.
 *
 * Run: npx tsx --tsconfig careervine-mcp/tsconfig.json careervine-mcp/server.ts
 * (registered for Claude Code in the repo-root .mcp.json)
 *
 * Single-user by construction: every query is scoped to the user
 * resolved at startup (CAREERVINE_USER_ID / CAREERVINE_USER_EMAIL).
 * Credentials come from careervine/.env.local — never logged, never in
 * .mcp.json. stdout is the protocol channel; diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./lib/env.ts";
import { initDb } from "@/mcp/lib/db";
import { registerAllTools } from "@/mcp/register-tools";

async function main() {
  const { userId } = await loadEnv();
  initDb(userId);

  const server = new McpServer({
    name: "careervine",
    version: "1.0.0",
  });

  registerAllTools(server);

  await server.connect(new StdioServerTransport());
  console.error("careervine MCP server ready (stdio)");
}

main().catch((err) => {
  console.error(`careervine MCP server failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
