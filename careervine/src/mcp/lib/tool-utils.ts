/**
 * Shared plumbing for tool registration: JSON responses, error mapping,
 * and the contact_id|name reference shape most tools accept.
 */

import { z } from "zod";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  /** Machine-readable mirror of `content`, required by any tool with an outputSchema. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Every tool's response, as both a text block and structured data (CAR-272).
 *
 * The text block is unchanged and stays first: clients that only read
 * `content[0].text` — including a Cowork agent already connected to this server
 * — see exactly what they saw before. `structuredContent` is purely additive.
 *
 * It is set for EVERY tool, not only the ones declaring an `outputSchema`,
 * because the SDK treats that schema as a runtime contract rather than
 * documentation: `validateToolOutput` throws McpError when a tool declares a
 * schema and returns no structured content, and throws again if the content
 * fails to parse. Populating it unconditionally here means declaring a schema
 * later is a one-line change that cannot forget its half of the bargain.
 *
 * Arrays and primitives are deliberately not promoted: `structuredContent` is
 * an object per the MCP spec, and every tool here already returns an object
 * with a `summary`.
 */
export function ok(payload: unknown): ToolResult {
  const result: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    result.structuredContent = payload as Record<string, unknown>;
  }
  return result;
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so thrown errors become MCP tool errors, not crashes. */
export function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

/** contact_id | name reference — used by every contact-scoped tool. */
export const contactRefShape = {
  contact_id: z.number().int().optional().describe("Contact id (preferred when known)"),
  name: z
    .string()
    .optional()
    .describe("Contact name — exact or partial; ambiguous matches return candidates with ids"),
};

export const companyRefShape = {
  company_id: z.number().int().optional().describe("Company id (preferred when known)"),
  name: z
    .string()
    .optional()
    .describe("Company name — exact or partial; ambiguous matches return candidates with ids"),
};
