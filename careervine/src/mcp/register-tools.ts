/**
 * Register all CareerVine MCP tools on a server instance.
 * Shared by the stdio shell (careervine-mcp) and the remote HTTP route (CAR-13).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContactTools } from "./tools/contacts";
import { registerEmailTools } from "./tools/email";
import { registerOutreachTools } from "./tools/outreach";
import { registerUpkeepTools } from "./tools/upkeep";
import { registerCalendarTools } from "./tools/calendar";

export function registerAllTools(server: McpServer): void {
  registerContactTools(server);
  registerEmailTools(server);
  registerOutreachTools(server);
  registerUpkeepTools(server);
  registerCalendarTools(server);
}
