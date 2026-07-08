/**
 * Environment bootstrap for the CareerVine MCP server.
 *
 * Credentials are read from careervine/.env.local (never from .mcp.json,
 * which is committed). The server refuses to start when required vars
 * are missing. Values are never logged.
 *
 * Supabase target: with NODE_ENV unset (the normal MCP case) the app's
 * getSupabaseEnv() resolves to the PRODUCTION project. Set
 * NODE_ENV=development in the server's env to follow the app's local
 * stack logic instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Parse a dotenv-style file and merge into process.env (existing vars win). */
function loadDotEnvFile(filePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${filePath} — the MCP server loads its credentials from careervine/.env.local.`,
    );
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

/**
 * Load careervine/.env.local and resolve the operating user.
 * CAREERVINE_USER_ID wins; otherwise CAREERVINE_USER_EMAIL is resolved
 * against auth.users at startup. Returns the user id.
 */
export async function loadEnv(): Promise<{ userId: string }> {
  loadDotEnvFile(path.join(REPO_ROOT, "careervine", ".env.local"));

  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars in careervine/.env.local: ${missing.join(", ")}`,
    );
  }

  if (process.env.CAREERVINE_USER_ID) {
    return { userId: process.env.CAREERVINE_USER_ID };
  }

  const email = process.env.CAREERVINE_USER_EMAIL;
  if (!email) {
    throw new Error(
      "Set CAREERVINE_USER_ID (auth.users id) or CAREERVINE_USER_EMAIL in the MCP server env (.mcp.json).",
    );
  }

  // Resolve email → id via the admin API (import lazily: env must be set first)
  const { createSupabaseServiceClient } = await import(
    "@/lib/supabase/service-client"
  );
  const service = createSupabaseServiceClient();
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`Failed to list users: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return { userId: match.id };
    if (data.users.length < 100) break;
  }
  throw new Error(`No auth user found for CAREERVINE_USER_EMAIL=${email}`);
}
