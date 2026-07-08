/**
 * Manual end-to-end smoke test: boots the MCP server over stdio exactly
 * the way Claude Code does, lists the tools, and exercises the read-only
 * ones. Never sends, drafts, or writes anything.
 *
 * Run from careervine-mcp/:
 *   npx tsx scripts/e2e.ts "<search query>"        # against prod
 *   NODE_ENV=development npx tsx scripts/e2e.ts …  # against the local stack
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const query = process.argv[2] ?? "a";

function preview(result: unknown, chars = 800): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? JSON.stringify(result);
  return text.length > chars ? `${text.slice(0, chars)}\n  … (${text.length} chars total)` : text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: path.join(pkgRoot, "node_modules", ".bin", "tsx"),
    args: ["--tsconfig", path.join(pkgRoot, "tsconfig.json"), path.join(pkgRoot, "server.ts")],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "careervine-e2e", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\n${tools.length} tools registered:`);
  console.log(tools.map((t) => `  ${t.name}`).join("\n"));

  const readOnlyCalls: Array<[string, Record<string, unknown>]> = [
    ["search_contacts", { query, limit: 3 }],
    ["get_network_health", {}],
    ["list_due_followups", {}],
    ["list_scheduled", {}],
    ["list_action_items", { due: "week" }],
    ["list_outreach_queue", { limit: 3 }],
    ["list_meetings", { range: "week" }],
  ];

  let firstContactId: number | null = null;
  let firstCompanyId: number | null = null;

  for (const [name, args] of readOnlyCalls) {
    console.log(`\n── ${name} ${JSON.stringify(args)} ──`);
    try {
      const result = await client.callTool({ name, arguments: args });
      console.log(preview(result));
      const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text) as {
          results?: Array<{ contact_id: number }>;
          queue?: Array<{ company_id: number }>;
        };
        if (name === "search_contacts") firstContactId = parsed.results?.[0]?.contact_id ?? null;
        if (name === "list_outreach_queue") firstCompanyId = parsed.queue?.[0]?.company_id ?? null;
      }
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Drill-downs on whatever the sweeps surfaced
  const drillDowns: Array<[string, Record<string, unknown>]> = [];
  if (firstContactId != null) drillDowns.push(["get_contact_dossier", { contact_id: firstContactId }]);
  if (firstCompanyId != null) drillDowns.push(["get_company", { company_id: firstCompanyId }]);
  for (const [name, args] of drillDowns) {
    console.log(`\n── ${name} ${JSON.stringify(args)} ──`);
    try {
      const result = await client.callTool({ name, arguments: args });
      console.log(preview(result, 1500));
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
