/**
 * Shared plumbing for tool registration: JSON responses, error mapping,
 * and the contact_id|name reference shape most tools accept.
 */

import { z } from "zod";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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
