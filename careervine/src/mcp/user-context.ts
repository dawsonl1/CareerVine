/**
 * Per-request MCP user id (CAR-13).
 *
 * HTTP requests scope via AsyncLocalStorage; the stdio server sets a
 * process-level fallback via initDb(userId).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ userId: string }>();

export function runWithUser<T>(userId: string, fn: () => T): T {
  return store.run({ userId }, fn);
}

export async function runWithUserAsync<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId }, fn);
}

/** Active request user, if any. */
export function currentUserIdOrNull(): string | null {
  return store.getStore()?.userId ?? null;
}

/** HTTP handlers must have ALS context — never fall back to stdio's global user. */
export function requireRequestUserId(): string {
  const id = currentUserIdOrNull();
  if (!id) throw new Error("MCP request has no authenticated user context");
  return id;
}
