/**
 * Register all CareerVine MCP tools on a server instance.
 * Shared by the stdio shell (careervine-mcp) and the remote HTTP route (CAR-13).
 *
 * Every tool registration is wrapped with analytics (CAR-38): one
 * mcp_tool_called event per invocation, carrying the tool name, success flag,
 * and duration, attributed to the operating user. Tracking is fire-and-forget
 * and can never fail a tool call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContactTools } from "./tools/contacts";
import { registerEmailTools } from "./tools/email";
import { registerOutreachTools } from "./tools/outreach";
import { registerUpkeepTools } from "./tools/upkeep";
import { registerCalendarTools } from "./tools/calendar";
import { trackServer } from "@/lib/analytics/server";
import { uid } from "./lib/db";

type ToolResult = { isError?: boolean } | undefined;
type ToolCallback = (...args: unknown[]) => Promise<ToolResult>;

function instrumentToolCalls(server: McpServer): void {
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: ToolCallback) => {
    const wrapped: ToolCallback = async (...args) => {
      const startedAt = Date.now();
      const result = await cb(...args);
      try {
        // Awaited: on the serverless remote MCP route nothing drains pending
        // captures before the lambda freezes, so fire-and-forget events were
        // silently dropped (CAR-58). trackServer never throws, and flushAt:1
        // sends immediately — one extra round-trip per tool call.
        await trackServer(
          uid(),
          "mcp_tool_called",
          { tool: name, success: !result?.isError, duration_ms: Date.now() - startedAt },
          "mcp",
        );
      } catch {
        // no user context (or analytics failure) — never fail the tool call
      }
      return result;
    };
    return original(name as never, config as never, wrapped as never);
  }) as typeof server.registerTool;
}

export function registerAllTools(server: McpServer): void {
  instrumentToolCalls(server);
  registerContactTools(server);
  registerEmailTools(server);
  registerOutreachTools(server);
  registerUpkeepTools(server);
  registerCalendarTools(server);
}
